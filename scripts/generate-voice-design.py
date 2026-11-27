"""Isolated, offline, bounded VoiceDesign GPU worker. One model, 1-3 sequential auditions."""
import json
import os
import sys
import time
import traceback
import threading
import urllib.request
import subprocess
from pathlib import Path

os.environ['HF_HUB_OFFLINE'] = '1'
os.environ['TRANSFORMERS_OFFLINE'] = '1'
os.environ['HF_HUB_DISABLE_TELEMETRY'] = '1'
job = Path(sys.argv[1]).resolve()
plan = json.loads((job / 'input.json').read_text(encoding='utf-8'))
root = Path(__file__).resolve().parents[1]
model_dir = root / 'runtime/models/Qwen3-TTS-12Hz-1.7B-VoiceDesign'
manifest = {'id': plan['id'], 'status': 'running', 'stage': '正在加载AI音色模型', 'description': plan['description'], 'text': plan['text'], 'candidates': [], 'model': str(model_dir), 'startedAt': time.time()}
done = threading.Event()

def save():
    temporary = job / 'status.tmp'
    temporary.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding='utf-8')
    temporary.replace(job / 'status.json')

try:
    save()
    def protect_other_gpu_jobs():
        while not done.wait(2):
            message = None
            try:
                with urllib.request.urlopen(plan.get('comfyUrl', 'http://127.0.0.1:8188') + '/queue', timeout=4) as response:
                    queue = json.load(response)
                if queue.get('queue_running') or queue.get('queue_pending'):
                    message = 'External ComfyUI GPU job detected; voice design stopped to protect it'
                if time.time() - manifest['startedAt'] > 15 * 60:
                    message = 'Voice design timed out after 15 minutes; no automatic retry'
                temperature = subprocess.check_output(['nvidia-smi', '--query-gpu=temperature.gpu', '--format=csv,noheader,nounits'], timeout=4, creationflags=subprocess.CREATE_NO_WINDOW).decode().strip().splitlines()[0]
                if int(temperature) >= 80:
                    message = 'GPU temperature reached 80C; own voice design task stopped'
            except Exception:
                message = 'ComfyUI queue cannot be verified; voice design stopped safely'
            if message:
                manifest.update(status='failed', error=message, finishedAt=time.time())
                try:
                    save()
                finally:
                    os._exit(3)
    threading.Thread(target=protect_other_gpu_jobs, daemon=True).start()
    import torch
    import soundfile as sf
    from qwen_tts import Qwen3TTSModel
    if not torch.cuda.is_available():
        raise RuntimeError('独立配音环境没有可用CUDA，未启动音色生成')
    free, total = torch.cuda.mem_get_info()
    if free < 8 * 1024**3:
        raise RuntimeError(f'空闲显存不足8GiB（当前约{free/1024**3:.1f}GiB），请先完成其他GPU任务；未加载模型，不会自动结束其他进程')
    torch.cuda.reset_peak_memory_stats()
    model = Qwen3TTSModel.from_pretrained(str(model_dir), device_map='cuda:0', dtype=torch.bfloat16, attn_implementation='sdpa', local_files_only=True)
    manifest['loadedAt'] = time.time()
    for index in range(plan['count']):
        seed = plan['seed'] + index
        torch.manual_seed(seed)
        torch.cuda.manual_seed_all(seed)
        manifest['stage'] = f'正在生成试听候选 {index+1}/{plan["count"]}'
        save()
        started = time.time()
        with torch.inference_mode():
            waves, sample_rate = model.generate_voice_design(text=plan['text'], language='Chinese', instruct=plan['description'], max_new_tokens=1536)
        wave = waves[0]
        filename = f'Frameflow_VoiceDesign_{plan["id"]}_{index+1}.wav'
        if len(wave) < sample_rate * 0.3:
            raise RuntimeError('Generated audition is empty or shorter than 0.3 seconds')
        sf.write(str(job / filename), wave, sample_rate, subtype='PCM_16')
        manifest['candidates'].append({'filename': filename, 'seed': seed, 'duration': len(wave)/sample_rate, 'seconds': time.time()-started, 'sampleRate': sample_rate})
        manifest['peakAllocatedMiB'] = torch.cuda.max_memory_allocated()/1024**2
        manifest['peakReservedMiB'] = torch.cuda.max_memory_reserved()/1024**2
        save()
    manifest['status'] = 'completed'
    manifest['stage'] = 'AI试听已完成'
    manifest['finishedAt'] = time.time()
    done.set()
    save()
except Exception as error:
    done.set()
    manifest.update(status='failed', error=str(error), stage='AI音色设计失败', finishedAt=time.time())
    save()
    traceback.print_exc()
    sys.exit(1)
