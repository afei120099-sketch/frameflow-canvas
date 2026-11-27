"""Director Stage Blender Bridge V0.1: white-box Scene -> Blender -> RGB still.

Reads the `director-stage.json` of a Frameflow project backup (or the backup folder itself),
rebuilds one Scene's room box, box/plane Props and one Camera, and renders:

    <out>/rgb.png       RGB white-box still (Workbench, exact 9:16 or 16:9)
    <out>/camera.json   camera / render / framing record

Usage (portable Blender, no add-ons, no system Python):

    blender.exe -b --factory-startup --python-exit-code 1 -P tools/blender/whitebox_render.py -- \
        --input <backup folder | director-stage.json> [--scene <id|name>] [--camera <id|name>] \
        [--out <dir>] [--long-side 1920] [--controls depth,mask,object-id] [--save-blend]

Conventions are the same as the three.js stage (lib/director-stage/whitebox.ts):
metres, Y up, the room's floor centre at the origin, rotations in degrees as three.js XYZ Euler
(matrix = Rx * Ry * Rz), a camera looks down its local -Z, the focal length is full-frame
equivalent against a 24 mm sensor HEIGHT, a box's origin is its bottom centre and a plane is a
1 x 1 square in its local XY. Every object is built in three.js coordinates and then mapped to
Blender's Z-up world by a +90 degree rotation about X: three (x, y, z) -> Blender (x, -z, y).

V0.1 renders RGB only: no depth / mask / normal, no Motion animation.
Motion V0.2 (export preparation only, nothing animated or rendered): when the Scene has Motions with
posed keyframes (keyframes[].transform), <out>/motion.json lists them with their Blender world matrices.

Advanced controls V0.1 (`--controls`): after the unchanged RGB still, ONE more render of the same scene /
camera / resolution with Cycles (1 sample, centre-of-pixel, no AA: data passes only) gives the Z and
object-index passes, from which (numpy + the OpenImageIO bundled with Blender):

    <out>/depth.png      8-bit grey, linear camera depth: nearest = 255, farthest = 1, nothing hit = 0
    <out>/mask.png       white = any placed Prop, black = room / background
    <out>/object-id.png  one flat colour per placed Prop (camera.json lists propId -> colour), black = room / background

camera.json gains a "controls" section (near / far metres, colours, visible pixels per Prop, render time).
"""

import hashlib
import json
import math
import os
import sys
import time

import bmesh
import bpy
from bpy_extras.object_utils import world_to_camera_view
from mathutils import Matrix, Vector

FORMAT = "frameflow-blender-camera-v1"
CONTROL_NAMES = ("depth", "mask", "object-id")
MOTION_FORMAT = "frameflow-blender-motion-v1"
MOTION_FPS = 24
SENSOR_HEIGHT_MM = 24.0
CLIP_START, CLIP_END = 0.05, 200.0
DEFAULT_FOCAL_LENGTH = 35.0
DEFAULT_ASPECT = "9:16"
# Same colours as components/director-stage/whitebox-stage.tsx.
COLORS = {"background": 0x101318, "room": 0x8D929C, "box": 0xDCD8CF, "plane": 0xC9D2DA}
THREE_TO_BLENDER = Matrix.Rotation(math.radians(90.0), 4, "X")


class BridgeError(Exception):
    pass


def parse_args(argv):
    args = argv[argv.index("--") + 1:] if "--" in argv else []
    options = {"input": None, "scene": None, "camera": None, "out": None, "long-side": "1920", "controls": "", "save-blend": False}
    index = 0
    while index < len(args):
        key = args[index].lstrip("-")
        if key not in options:
            raise BridgeError(f"未知参数：{args[index]}")
        if key == "save-blend":
            options[key] = True
            index += 1
            continue
        if index + 1 >= len(args):
            raise BridgeError(f"参数 {args[index]} 缺少取值")
        options[key] = args[index + 1]
        index += 2
    if not options["input"]:
        raise BridgeError("缺少 --input（项目备份文件夹或 director-stage.json）")
    long_side = int(options["long-side"])
    if long_side < 256 or long_side > 4096 or long_side % 16:
        raise BridgeError("--long-side 必须是 256–4096 之间、16 的倍数（保证画幅比例精确）")
    options["long-side"] = long_side
    controls = [name for name in options["controls"].split(",") if name]
    unknown = [name for name in controls if name not in CONTROL_NAMES]
    if unknown:
        raise BridgeError(f"未知的控制图：{'、'.join(unknown)}（可选：{','.join(CONTROL_NAMES)}）")
    options["controls"] = [name for name in CONTROL_NAMES if name in controls]
    return options


def load_director(path):
    path = os.path.abspath(path)
    if os.path.isdir(path):
        path = os.path.join(path, "director-stage.json")
    if not os.path.isfile(path):
        raise BridgeError(f"找不到导演台数据：{path}")
    with open(path, "rb") as handle:
        raw = handle.read()
    data = json.loads(raw.decode("utf-8"))
    for store in ("scenes", "props", "cameras"):
        if not isinstance(data.get(store), list):
            raise BridgeError(f"director-stage.json 缺少 {store}")
    return path, hashlib.sha256(raw).hexdigest(), data


def pick(rows, wanted, label):
    if wanted:
        matches = [row for row in rows if row.get("id") == wanted] or [row for row in rows if row.get("name") == wanted]
        if len(matches) != 1:
            raise BridgeError(f"{label}“{wanted}”{'不存在' if not matches else '重名，请改用 ID'}。可选：{describe(rows)}")
        return matches[0]
    if len(rows) != 1:
        raise BridgeError(f"有 {len(rows)} 个{label}，请用参数指定。可选：{describe(rows)}")
    return rows[0]


def describe(rows):
    return "；".join(f"{row.get('name')}（{row.get('id')}）" for row in rows) or "无"


def three_matrix(transform, with_scale=True):
    """three.js Object3D matrix: T * R(XYZ Euler) * S."""
    rx, ry, rz = (math.radians(value) for value in transform["rotation"])
    rotation = Matrix.Rotation(rx, 4, "X") @ Matrix.Rotation(ry, 4, "Y") @ Matrix.Rotation(rz, 4, "Z")
    scale = Matrix.Diagonal((*transform["scale"], 1.0)) if with_scale else Matrix.Identity(4)
    return Matrix.Translation(Vector(transform["position"])) @ rotation @ scale


def srgb_to_linear(hex_color):
    def channel(value):
        value /= 255.0
        return value / 12.92 if value <= 0.04045 else ((value + 0.055) / 1.055) ** 2.4
    return tuple(channel((hex_color >> shift) & 0xFF) for shift in (16, 8, 0))


def make_material(name, hex_color, backface_culling=False):
    material = bpy.data.materials.new(name)
    material.diffuse_color = (*srgb_to_linear(hex_color), 1.0)
    material.use_backface_culling = backface_culling
    return material


def mesh_object(name, build, matrix, material):
    """`build(bm)` creates geometry in three.js local coordinates; `matrix` is the three.js world matrix."""
    bm = bmesh.new()
    build(bm)
    mesh = bpy.data.meshes.new(name)
    bm.to_mesh(mesh)
    bm.free()
    mesh.materials.append(material)
    obj = bpy.data.objects.new(name, mesh)
    obj.matrix_world = THREE_TO_BLENDER @ matrix
    bpy.context.scene.collection.objects.link(obj)
    return obj


def unit_box(bm, size=(1.0, 1.0, 1.0), offset=(0.0, 0.0, 0.0), inward=False):
    bmesh.ops.create_cube(bm, size=1.0)
    bmesh.ops.transform(bm, matrix=Matrix.Translation(Vector(offset)) @ Matrix.Diagonal((*size, 1.0)), verts=bm.verts)
    if inward:
        bmesh.ops.reverse_faces(bm, faces=bm.faces)


def unit_plane(bm):
    bmesh.ops.create_grid(bm, x_segments=1, y_segments=1, size=0.5)


def build_scene(scene_row, props, camera_row, long_side):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene
    scene.name = "whitebox"

    room = scene_row.get("room")
    if room:
        material = make_material("room", COLORS["room"], backface_culling=True)  # three.js BackSide: see the inside only
        mesh_object("room", lambda bm: unit_box(bm, (room["width"], room["height"], room["depth"]), (0.0, room["height"] / 2, 0.0), inward=True), Matrix.Identity(4), material)

    built, skipped = [], []
    materials = {"box": make_material("box", COLORS["box"]), "plane": make_material("plane", COLORS["plane"])}
    for prop in props:
        geometry, transform = prop.get("geometry"), prop.get("transform")
        if geometry not in materials or not transform:
            skipped.append(prop.get("name"))
            continue
        builder = unit_plane if geometry == "plane" else (lambda bm: unit_box(bm, offset=(0.0, 0.5, 0.0)))
        built.append((prop, mesh_object(prop.get("name") or prop["id"], builder, three_matrix(transform), materials[geometry])))

    aspect = camera_row.get("aspect") or DEFAULT_ASPECT
    focal = float(camera_row.get("focalLength") or DEFAULT_FOCAL_LENGTH)
    width, height = (long_side * 9 // 16, long_side) if aspect == "9:16" else (long_side, long_side * 9 // 16)
    camera_data = bpy.data.cameras.new("camera")
    camera_data.sensor_fit = "VERTICAL"
    camera_data.sensor_height = SENSOR_HEIGHT_MM
    camera_data.lens = focal
    camera_data.clip_start, camera_data.clip_end = CLIP_START, CLIP_END
    camera = bpy.data.objects.new(camera_row.get("name") or "camera", camera_data)
    camera.matrix_world = THREE_TO_BLENDER @ three_matrix(camera_row["transform"], with_scale=False)
    scene.collection.objects.link(camera)
    scene.camera = camera

    world = bpy.data.worlds.new("background")
    world.color = srgb_to_linear(COLORS["background"])
    scene.world = world
    render = scene.render
    render.engine = "BLENDER_WORKBENCH"
    render.resolution_x, render.resolution_y, render.resolution_percentage = width, height, 100
    render.pixel_aspect_x = render.pixel_aspect_y = 1.0
    render.film_transparent = False
    render.image_settings.file_format = "PNG"
    render.image_settings.color_mode = "RGB"
    scene.view_settings.view_transform = "Standard"
    shading = scene.display.shading
    shading.light = "STUDIO"
    shading.color_type = "MATERIAL"
    shading.show_object_outline = True
    shading.show_cavity = True
    shading.cavity_type = "WORLD"
    scene.display.render_aa = "16"
    bpy.context.view_layer.update()
    return scene, camera, built, skipped, (width, height), focal, aspect


def framing(scene, camera, built):
    """Image-space bounding box (0..1, origin top-left) of each Prop's corners in front of the camera."""
    rows = []
    for prop, obj in built:
        points = [world_to_camera_view(scene, camera, obj.matrix_world @ vertex.co) for vertex in obj.data.vertices]
        front = [point for point in points if point.z > CLIP_START]
        if not front:
            rows.append({"propId": prop["id"], "name": prop.get("name"), "geometry": prop["geometry"], "inFront": False})
            continue
        xs, ys = [point.x for point in front], [1.0 - point.y for point in front]
        box = [round(min(xs), 4), round(min(ys), 4), round(max(xs), 4), round(max(ys), 4)]
        visible = box[2] > 0 and box[0] < 1 and box[3] > 0 and box[1] < 1
        rows.append({"propId": prop["id"], "name": prop.get("name"), "geometry": prop["geometry"], "inFront": True, "allCornersInFront": len(front) == len(points), "visible": visible, "bbox": box})
    return rows


def object_color(index):
    """Flat, well separated colour for Prop index 1, 2, … (golden-angle hues); 0 = room / background = black."""
    if index <= 0:
        return (0, 0, 0)
    hue = (index * 0.618033988749895) % 1.0
    sector, fraction = int(hue * 6), hue * 6 - int(hue * 6)
    value, low = 1.0, 0.25
    rising, falling = low + (value - low) * fraction, value - (value - low) * fraction
    r, g, b = [(value, rising, low), (falling, value, low), (low, value, rising), (low, falling, value), (rising, low, value), (value, low, falling)][sector % 6]
    return (round(r * 255), round(g * 255), round(b * 255))


def write_png(path, pixels):
    import OpenImageIO as oiio
    height, width = pixels.shape[:2]
    output = oiio.ImageOutput.create(path)
    if not output or not output.open(path, oiio.ImageSpec(width, height, 3, "uint8")):
        raise BridgeError(f"无法写入 {os.path.basename(path)}")
    output.write_image(pixels)
    output.close()


def data_material():
    """Emission R = camera-space depth (m), G = Object Index (pass_index), B = 1 (hit). No lighting involved."""
    material = bpy.data.materials.new("frameflow-data-pass")
    if material.node_tree is None:  # Blender < 5 creates materials without a node tree
        material.use_nodes = True
    nodes, links = material.node_tree.nodes, material.node_tree.links
    nodes.clear()
    camera = nodes.new("ShaderNodeCameraData")
    info = nodes.new("ShaderNodeObjectInfo")
    combine = nodes.new("ShaderNodeCombineXYZ")
    combine.inputs["Z"].default_value = 1.0
    emission = nodes.new("ShaderNodeEmission")
    emission.inputs["Strength"].default_value = 1.0
    output = nodes.new("ShaderNodeOutputMaterial")
    links.new(camera.outputs["View Z Depth"], combine.inputs["X"])
    links.new(info.outputs["Object Index"], combine.inputs["Y"])
    links.new(combine.outputs["Vector"], emission.inputs["Color"])
    links.new(emission.outputs["Emission"], output.inputs["Surface"])
    return material


def render_controls(scene, built, out_dir, wanted):
    """Depth / mask / object-id from one Cycles data render of the already built scene (same camera, same pixels as rgb.png).

    Blender 5.x writes only the Combined layer to files, so the data travels in the colour itself: every mesh
    gets an emission material (R = view Z depth, G = pass_index, B = 1) and the render goes to a float EXR,
    which stores scene-linear values untouched by colour management.
    """
    import numpy as np
    import OpenImageIO as oiio

    started = time.time()
    for index, (_prop, obj) in enumerate(built, start=1):
        obj.pass_index = index
    material = data_material()
    for obj in scene.objects:
        if obj.type == "MESH":
            obj.data.materials.clear()
            obj.data.materials.append(material)
    scene.world.color = (0.0, 0.0, 0.0)
    render = scene.render
    render.engine = "CYCLES"
    render.film_transparent = False
    cycles = scene.cycles
    cycles.device = "CPU"
    cycles.samples = 1
    cycles.use_adaptive_sampling = False
    cycles.use_denoising = False
    cycles.max_bounces = 0
    cycles.pixel_filter_type = "BOX"
    cycles.filter_width = 0.01  # one sample at the pixel centre: hard, exact edges for mask / id
    settings = render.image_settings
    if hasattr(settings, "media_type"):
        settings.media_type = "IMAGE"
    settings.file_format = "OPEN_EXR"
    settings.color_mode = "RGB"
    settings.color_depth = "32"
    settings.exr_codec = "ZIP"
    exr = os.path.join(out_dir, "_data.exr")
    render.filepath = exr
    bpy.ops.render.render(write_still=True)

    source = oiio.ImageInput.open(exr)
    if not source:
        raise BridgeError("无法读取数据渲染 EXR")
    spec = source.spec()
    pixels = source.read_image(0, 0, 0, 3, "float")
    source.close()
    os.remove(exr)
    hit = pixels[:, :, 2] > 0.5
    depth = np.where(hit, pixels[:, :, 0], np.inf)
    index = np.where(hit, np.rint(pixels[:, :, 1]), 0).astype(np.int32)
    height, width = depth.shape
    result = {"engine": "CYCLES (1 sample at pixel centre, emission data render)", "renderedAt": time.strftime("%Y-%m-%dT%H:%M:%S%z"), "width": width, "height": height}
    placed = [{"propId": prop["id"], "name": prop.get("name"), "index": at} for at, (prop, _obj) in enumerate(built, start=1)]

    if "depth" in wanted:
        valid = np.isfinite(depth) & (depth < CLIP_END)
        near = float(depth[valid].min()) if valid.any() else 0.0
        far = float(depth[valid].max()) if valid.any() else 0.0
        span = max(far - near, 1e-6)
        grey = np.zeros(depth.shape, dtype=np.uint8)
        grey[valid] = np.rint(1 + 254 * (far - depth[valid]) / span).astype(np.uint8)
        write_png(os.path.join(out_dir, "depth.png"), np.repeat(grey[:, :, None], 3, axis=2))
        result["depth"] = {
            "file": "depth.png", "nearM": round(near, 4), "farM": round(far, 4),
            "encoding": "8-bit grey, linear camera-space depth (metres along the view axis): value = 1 + 254 * (far - z) / (far - near); 255 = nearest, 1 = farthest, 0 = nothing hit",
            "sources": ["room"] + [row["propId"] for row in placed] if scene.objects.get("room") else [row["propId"] for row in placed],
        }
    counts = {row["index"]: int((index == row["index"]).sum()) for row in placed}
    if "mask" in wanted:
        white = np.where(index > 0, 255, 0).astype(np.uint8)
        write_png(os.path.join(out_dir, "mask.png"), np.repeat(white[:, :, None], 3, axis=2))
        result["mask"] = {"file": "mask.png", "encoding": "white = any placed Prop, black = room / background", "propIds": [row["propId"] for row in placed if counts[row["index"]]], "pixels": int((index > 0).sum())}
    if "object-id" in wanted:
        table = np.array([object_color(at) for at in range(len(placed) + 1)], dtype=np.uint8)
        write_png(os.path.join(out_dir, "object-id.png"), table[np.clip(index, 0, len(placed))])
        result["objectId"] = {"file": "object-id.png", "background": [0, 0, 0], "objects": [{**row, "color": list(object_color(row["index"])), "pixels": counts[row["index"]]} for row in placed]}
    result["seconds"] = round(time.time() - started, 2)
    return result


def matrix_rows(matrix):
    return [[round(value, 6) for value in row] for row in matrix]


def motion_tracks(data, scene_id):
    """Motion V0.2 export preparation: every posed keyframe of the Scene's Motions, in three.js space and as a Blender world matrix."""
    targets = {row["id"]: row for row in data.get("props", []) + data.get("cameras", [])}
    tracks = []
    for motion in data.get("motions") or []:
        posed = [keyframe for keyframe in motion.get("keyframes", []) if keyframe.get("transform")]
        if motion.get("sceneId") != scene_id or not posed:
            continue
        camera = motion.get("targetType") == "camera"
        target = targets.get(motion.get("targetId"), {})
        tracks.append({
            "motionId": motion["id"], "name": motion.get("name"), "targetType": motion.get("targetType"), "targetId": motion.get("targetId"),
            "targetName": target.get("name"), "geometry": target.get("geometry"),
            "keyframes": [{
                "frame": keyframe["frame"], "seconds": round(keyframe["frame"] / MOTION_FPS, 3), "description": keyframe.get("description", ""),
                "transform": keyframe["transform"],
                # Cameras ignore scale, as in the stage; Props keep it (box pivot = bottom centre, same mesh as the still).
                "blenderMatrixWorld": matrix_rows(THREE_TO_BLENDER @ three_matrix(keyframe["transform"], with_scale=not camera)),
            } for keyframe in posed],
        })
    return tracks


def main():
    options = parse_args(sys.argv)
    source_path, source_sha, data = load_director(options["input"])
    scene_row = pick(data["scenes"], options["scene"], "场景")
    placed = [row for row in data["cameras"] if row.get("sceneId") == scene_row["id"] and row.get("transform")]
    camera_row = pick(placed, options["camera"], "已放入白模的摄影机")
    props = [row for row in data["props"] if row.get("sceneId") == scene_row["id"]]

    out_dir = os.path.abspath(options["out"] or os.path.join(os.path.dirname(source_path), "blender-out", f"{scene_row['id']}__{camera_row['id']}"))
    os.makedirs(out_dir, exist_ok=True)
    started = time.time()
    scene, camera, built, skipped, (width, height), focal, aspect = build_scene(scene_row, props, camera_row, options["long-side"])
    scene.render.filepath = os.path.join(out_dir, "rgb.png")
    bpy.ops.render.render(write_still=True)
    rgb_seconds = round(time.time() - started, 2)
    controls = render_controls(scene, built, out_dir, options["controls"]) if options["controls"] else None
    if options["save-blend"]:
        bpy.ops.wm.save_as_mainfile(filepath=os.path.join(out_dir, "whitebox.blend"), check_existing=False)

    record = {
        "format": FORMAT,
        "source": {"file": os.path.basename(source_path), "sha256": source_sha},
        "scene": {"id": scene_row["id"], "name": scene_row.get("name"), "room": scene_row.get("room")},
        "camera": {
            "id": camera_row["id"], "name": camera_row.get("name"), "focalLength": focal, "aspect": aspect,
            "transform": camera_row["transform"],
            "verticalFovDeg": round(math.degrees(2 * math.atan(SENSOR_HEIGHT_MM / 2 / focal)), 4),
            "sensorFit": "VERTICAL", "sensorHeightMm": SENSOR_HEIGHT_MM, "clipStart": CLIP_START, "clipEnd": CLIP_END,
            "blenderMatrixWorld": matrix_rows(camera.matrix_world),
        },
        "coordinates": "transforms are three.js space (metres, Y up, XYZ Euler degrees); Blender world = Rx(+90deg) * three",
        "render": {"file": "rgb.png", "width": width, "height": height, "engine": "BLENDER_WORKBENCH", "blenderVersion": bpy.app.version_string, "seconds": rgb_seconds},
        "framing": framing(scene, camera, built),
        "skippedProps": skipped,
        "motionFile": None,
        "controls": controls,
        "createdAt": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
    }
    tracks = motion_tracks(data, scene_row["id"])
    if tracks:
        motion = {
            "format": MOTION_FORMAT, "fps": MOTION_FPS, "sceneId": scene_row["id"], "source": record["source"],
            "note": "export preparation only: nothing is animated or rendered yet; the still above uses the saved placement",
            "interpolation": "linear position / scale, rotation per axis the shorter way round (same as the three.js preview); hold outside the keyframes",
            "coordinates": record["coordinates"], "tracks": tracks,
        }
        with open(os.path.join(out_dir, "motion.json"), "w", encoding="utf-8", newline="\n") as handle:
            json.dump(motion, handle, ensure_ascii=False, indent=2)
            handle.write("\n")
        record["motionFile"] = "motion.json"
    with open(os.path.join(out_dir, "camera.json"), "w", encoding="utf-8", newline="\n") as handle:
        json.dump(record, handle, ensure_ascii=False, indent=2)
        handle.write("\n")
    print(f"[whitebox_render] OK {width}x{height} -> {out_dir}")


if __name__ == "__main__":
    try:
        main()
    except BridgeError as error:
        print(f"[whitebox_render] 错误：{error}", file=sys.stderr)
        sys.exit(2)
