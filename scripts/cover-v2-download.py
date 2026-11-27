"""Explicit, pinned allowlist. Never installs packages or downloads optional models."""
import argparse, hashlib, json, os, subprocess, urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
STATE = ROOT / 'runtime/cover-v2'
COMFY = Path(os.environ.get('FRAMEFLOW_COMFYUI_ROOT') or 'C:/ComfyUI_windows_portable/ComfyUI')
MAT_REV = 'eccde0a8cbdce7ac5fecfeb06340fe7b949e85d9'
FILES = {
 'a': [('ZhengPeng7/BiRefNet-matting', MAT_REV, n, STATE/'models/BiRefNet-matting'/n) for n in ['config.json','BiRefNet_config.py','birefnet.py','requirements.txt','README.md','model.safetensors']],
 'b': [('black-forest-labs/FLUX.2-klein-4b-fp8','5b4408e59397a4a37ccb46afe426d8ed86379441','flux-2-klein-4b-fp8.safetensors',COMFY/'models/diffusion_models/flux-2-klein-4b-fp8.safetensors'),
       ('Comfy-Org/flux2-klein-4B','5f526678002e43af5551dadb73ce2e8c91b43afe','split_files/text_encoders/qwen_3_4b.safetensors',COMFY/'models/text_encoders/qwen_3_4b.safetensors'),
       ('Comfy-Org/flux2-klein-4B','5f526678002e43af5551dadb73ce2e8c91b43afe','split_files/vae/flux2-vae.safetensors',COMFY/'models/vae/flux2-vae.safetensors')]
}
def fetch(url):
    with urllib.request.urlopen(url, timeout=60) as r: return r.read()
def digest(path):
    h=hashlib.sha256()
    with path.open('rb') as f:
        for b in iter(lambda:f.read(8*1024*1024),b''): h.update(b)
    return h.hexdigest()
def main():
    stage=argparse.ArgumentParser();stage.add_argument('stage',choices=FILES);args=stage.parse_args()
    STATE.mkdir(parents=True,exist_ok=True); records=[]; cache={}
    for repo,rev,name,dest in FILES[args.stage]:
        key=(repo,rev)
        if key not in cache: cache[key]=json.loads(fetch(f'https://huggingface.co/api/models/{repo}/revision/{rev}?blobs=true'))
        meta=next(x for x in cache[key]['siblings'] if x['rfilename']==name)
        expected=meta.get('lfs',{}).get('sha256');url=f'https://huggingface.co/{repo}/resolve/{rev}/{name}'
        dest.parent.mkdir(parents=True,exist_ok=True)
        if not dest.exists():
            part=dest.with_suffix(dest.suffix+'.part')
            print('Downloading',name,meta['size'],flush=True)
            subprocess.run(['curl.exe','--fail','--location','--retry','5','--continue-at','-','--output',str(part),url],check=True)
            if part.stat().st_size!=meta['size'] or expected and digest(part)!=expected: raise RuntimeError('Integrity failed: '+name)
            part.rename(dest)
        sha=digest(dest)
        if dest.stat().st_size!=meta['size'] or expected and sha!=expected: raise RuntimeError('Existing file mismatch: '+str(dest))
        record=dict(repo=repo,revision=rev,file=name,path=str(dest),size=dest.stat().st_size,sha256=sha,upstreamSha256=expected,license=cache[key].get('cardData',{}).get('license'),url=url)
        records.append(record); print('VERIFIED',name,sha,flush=True)
        (STATE/f'downloads-{args.stage}.json').write_text(json.dumps(records,indent=2),encoding='utf8')
    if args.stage=='a':
        extras=[('https://raw.githubusercontent.com/ZhengPeng7/BiRefNet/main/LICENSE',STATE/'licenses/BiRefNet-MIT.txt'),
                ('https://raw.githubusercontent.com/google/fonts/main/ofl/mashanzheng/MaShanZheng-Regular.ttf',STATE/'fonts/MaShanZheng-Regular.ttf'),
                ('https://raw.githubusercontent.com/google/fonts/main/ofl/mashanzheng/OFL.txt',STATE/'licenses/MaShanZheng-OFL.txt')]
    else:
        extras=[('https://huggingface.co/black-forest-labs/FLUX.2-klein-4B/raw/main/LICENSE.md',STATE/'licenses/Klein-Apache2.txt'),
                ('https://raw.githubusercontent.com/Comfy-Org/workflow_templates/04a508b31bec1818e48122ca0761c1de4140a234/templates/image_flux2_klein_image_edit_4b_distilled.json',STATE/'klein-official-workflow.json')]
    for url,dest in extras:
        dest.parent.mkdir(parents=True,exist_ok=True)
        if not dest.exists(): dest.write_bytes(fetch(url))
        records.append(dict(url=url,path=str(dest),size=dest.stat().st_size,sha256=digest(dest)))
    (STATE/f'downloads-{args.stage}.json').write_text(json.dumps(records,indent=2),encoding='utf8')
if __name__=='__main__': main()
