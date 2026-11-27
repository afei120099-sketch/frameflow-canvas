"""Render existing animated Blender scene into aligned control anchor frames.

Reuses the established Director Stage renderer; input geometry is never edited
or resaved. This wrapper does not connect Depth/Pose to a video model.
Run inside Blender: -P this_file -- --input scene.blend --out DIR --frames 0,36,72
"""
import argparse,hashlib,importlib.util,json,sys
from pathlib import Path
import bpy

def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--input',required=True);parser.add_argument('--out',required=True)
    parser.add_argument('--frames',default='0,36,72,108,143')
    parser.add_argument('--bridge',default=str(Path(__file__).with_name('whitebox_render.py')))
    args=parser.parse_args(sys.argv[sys.argv.index('--')+1:] if '--' in sys.argv else [])
    source=Path(args.input).resolve();out=Path(args.out).resolve()
    frames=sorted(set(int(x) for x in args.frames.split(',')))
    if not source.is_file() or source.suffix.lower()!='.blend':raise ValueError('Existing .blend required')
    if not frames or min(frames)<0:raise ValueError('Nonnegative frames required')
    if (out/'control-sequence.json').exists():raise ValueError('Output already contains sequence; choose a new directory')
    out.mkdir(parents=True,exist_ok=True)
    spec=importlib.util.spec_from_file_location('director_stage_bridge',args.bridge)
    bridge=importlib.util.module_from_spec(spec);spec.loader.exec_module(bridge)
    original_sha=hashlib.sha256(source.read_bytes()).hexdigest()
    bpy.ops.wm.open_mainfile(filepath=str(source));scene=bpy.context.scene
    if not scene.camera:raise ValueError('Scene camera missing')
    room_names={'floor','back_wall','side_wall','room'}
    built=[({'id':o.name,'name':o.name},o) for o in sorted(scene.objects,key=lambda o:o.name) if o.type=='MESH' and o.name not in room_names]
    metadata=[]
    # First render all RGB while original shading remains intact.
    for f in frames:
        scene.frame_set(f+1);d=out/f'frame_{f:04d}';d.mkdir(exist_ok=True)
        scene.render.engine='BLENDER_WORKBENCH';scene.render.image_settings.file_format='PNG';scene.render.filepath=str(d/'rgb.png')
        bpy.ops.render.render(write_still=True)
        metadata.append({'frame':f,'seconds':f/scene.render.fps,'directory':str(d),
          'world_matrices':{o.name:bridge.matrix_rows(o.matrix_world) for _,o in built}})
    for record in metadata:
        scene.frame_set(record['frame']+1)
        record['controls']=bridge.render_controls(scene,built,record['directory'],['depth','mask','object-id'])
    assert hashlib.sha256(source.read_bytes()).hexdigest()==original_sha,'Input scene unexpectedly changed'
    result={'format':'frameflow-rendered-control-sequence-v1','source':str(source),'source_sha256':original_sha,
      'fps':scene.render.fps,'width':scene.render.resolution_x,'height':scene.render.resolution_y,
      'approved_room':False,'input_preserved':True,'native_h3_depth_pose_connected':False,
      'depth_mapping':'per-anchor normalization; each nearM/farM retained. Normalize to common range before video Depth control.',
      'frames':metadata}
    (out/'control-sequence.json').write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf8')
    print('CONTROL_SEQUENCE_COMPLETE',len(metadata))

if __name__=='__main__':main()
