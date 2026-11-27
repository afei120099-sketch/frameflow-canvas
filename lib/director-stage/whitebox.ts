import { TransformSchema, WHITEBOX_LIMITS, type CameraAspect, type PropGeometry, type Room, type Transform } from "./schema.ts";

/**
 * 3D white-box stage V0.1-A — pure helpers (no three.js here, so they are testable and cheap to import).
 * Convention: metres, Y up, the room's floor centre at the origin, rotations in degrees (XYZ Euler).
 * A camera looks down its local −Z; focal length is 35 mm full-frame equivalent (24 mm sensor height).
 */

export const DEFAULT_ROOM: Room = { width: 4, depth: 5, height: 2.8 };
export const DEFAULT_FOCAL_LENGTH = 35;
export const DEFAULT_CAMERA_ASPECT: CameraAspect = "9:16";
const SENSOR_HEIGHT_MM = 24;

const round = (value: number, digits = 3) => Math.round(value * 10 ** digits) / 10 ** digits;
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/** Snaps a transform to the stored precision (mm / 0.1° / 0.001) and clamps it into the schema limits. */
export function normalizeTransform(transform: Transform): Transform {
  const limit = WHITEBOX_LIMITS;
  const normalized: Transform = {
    position: transform.position.map((value) => round(clamp(value, -limit.position, limit.position))) as Transform["position"],
    rotation: transform.rotation.map((value) => round(clamp(((value % 360) + 540) % 360 - 180, -limit.rotation, limit.rotation), 1)) as Transform["rotation"],
    scale: transform.scale.map((value) => round(clamp(value, limit.scaleMin, limit.scaleMax))) as Transform["scale"],
  };
  return TransformSchema.parse(normalized);
}

/**
 * A new Prop stands on the floor near the room centre; boxes start chair-sized, planes lie flat.
 * A box's origin is its BOTTOM centre (scaling grows it up from the floor); a plane's origin is its centre.
 */
export function defaultPropTransform(geometry: PropGeometry, index = 0): Transform {
  const offset = (index % 5) * 0.6 - 1.2;
  if (geometry === "plane") return normalizeTransform({ position: [offset, 0.005, 0], rotation: [-90, 0, 0], scale: [1, 1, 1] });
  return normalizeTransform({ position: [offset, 0, 0], rotation: [0, 0, 0], scale: [0.5, 0.9, 0.5] });
}

/** A new Camera stands near the front wall at eye height, looking into the room (−Z). */
export function defaultCameraTransform(room: Room = DEFAULT_ROOM, index = 0): Transform {
  return normalizeTransform({ position: [(index % 3) * 0.5 - 0.5, 1.5, room.depth / 2 - 0.3], rotation: [0, 0, 0], scale: [1, 1, 1] });
}

/** Vertical field of view (degrees) of a full-frame-equivalent focal length. */
export function focalToVerticalFov(focalLength: number) {
  return round((2 * Math.atan(SENSOR_HEIGHT_MM / 2 / focalLength) * 180) / Math.PI, 2);
}

export const aspectRatio = (aspect: CameraAspect) => (aspect === "16:9" ? 16 / 9 : 9 / 16);

export const degToRad = (deg: number) => (deg * Math.PI) / 180;
export const radToDeg = (rad: number) => (rad * 180) / Math.PI;

/** Largest box of the given aspect that fits the container (for the letterboxed camera view). */
export function fitAspect(containerWidth: number, containerHeight: number, aspect: number) {
  const width = Math.min(containerWidth, containerHeight * aspect);
  return { width: Math.max(1, Math.floor(width)), height: Math.max(1, Math.floor(width / aspect)) };
}
