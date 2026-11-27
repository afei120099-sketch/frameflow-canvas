"""Pinned local BiRefNet inference; CPU by default so it cannot race H3 sampling."""
import hashlib, importlib.util, json, os, sys, time
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
ENV=ROOT/'runtime/cover-v2'
sys.path.insert(0,str(ENV/'site-packages'))
os.environ['HF_HUB_OFFLINE']='1'
os.environ['TRANSFORMERS_OFFLINE']='1'
REVISION='eccde0a8cbdce7ac5fecfeb06340fe7b949e85d9'

def predict(img,device='cpu'):
    import torch
    import numpy as np
    from PIL import Image
    from safetensors.torch import load_file
    model_dir=ENV/'models/BiRefNet-matting'
    # Only execute the exact source files verified by the approved downloader.
    records=json.loads((ENV/'downloads-a.json').read_text(encoding='utf8'))
    for name in ['birefnet.py','BiRefNet_config.py','config.json']:
        record=next(r for r in records if r.get('file')==name)
        if record['revision']!=REVISION or hashlib.sha256((model_dir/name).read_bytes()).hexdigest()!=record['sha256']:
            raise ValueError('BiRefNet源码校验失败，停止加载')
    spec=importlib.util.spec_from_file_location('cover_birefnet',model_dir/'birefnet.py',submodule_search_locations=[str(model_dir)])
    module=importlib.util.module_from_spec(spec);sys.modules[spec.name]=module;spec.loader.exec_module(module)
    torch.set_num_threads(8)
    if device not in ('cpu','cuda'):raise ValueError('无效推理设备')
    if device=='cuda':
        import urllib.request
        with urllib.request.urlopen('http://127.0.0.1:8188/queue',timeout=10) as r:q=json.load(r)
        if q.get('queue_running') or q.get('queue_pending'):raise ValueError('ComfyUI有任务，不运行独立抠图GPU测试')
        torch.cuda.reset_peak_memory_stats()
    start=time.perf_counter()
    model=module.BiRefNet(config=module.BiRefNetConfig(bb_pretrained=False))
    model.load_state_dict(load_file(str(model_dir/'model.safetensors')),strict=True)
    model.eval().requires_grad_(False).to(device)
    tensor=torch.from_numpy(np.asarray(img.convert('RGB').resize((1024,1024),Image.Resampling.LANCZOS)).copy()).permute(2,0,1).float().div(255)
    tensor=((tensor-torch.tensor([.485,.456,.406])[:,None,None])/torch.tensor([.229,.224,.225])[:,None,None]).unsqueeze(0).to(device)
    with torch.inference_mode(),torch.autocast(device_type=device,dtype=torch.float16,enabled=device=='cuda'):
        alpha=model(tensor)[-1].sigmoid().float().cpu()[0,0].numpy()
    if not np.isfinite(alpha).all():raise ValueError('BiRefNet输出非有限数值；请使用透明PNG或人工遮罩')
    metrics={'model':'ZhengPeng7/BiRefNet-matting','revision':REVISION,'device':device,'seconds':time.perf_counter()-start,'torch':torch.__version__,'peakAllocatedMiB':torch.cuda.max_memory_allocated()/2**20 if device=='cuda' else 0,'peakReservedMiB':torch.cuda.max_memory_reserved()/2**20 if device=='cuda' else 0}
    result=Image.fromarray(np.uint8(np.rint(np.clip(alpha,0,1)*255)),'L').resize(img.size,Image.Resampling.LANCZOS)
    del model,tensor
    if device=='cuda':torch.cuda.empty_cache()
    return result,metrics

if __name__=='__main__':
    from PIL import Image
    source=Image.open(sys.argv[1]);alpha,metrics=predict(source,sys.argv[3] if len(sys.argv)>3 else 'cpu')
    alpha.save(sys.argv[2]);Path(sys.argv[2]+'.json').write_text(json.dumps(metrics,indent=2),encoding='utf8');print(json.dumps(metrics),flush=True)
