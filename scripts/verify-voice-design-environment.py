import importlib.metadata as metadata
import json
from pathlib import Path
import sys
import torch
import torchaudio
from qwen_tts import Qwen3TTSModel
assert torch.__version__.startswith('2.8.0'), torch.__version__
assert torchaudio.__version__.startswith('2.8.0'), torchaudio.__version__
assert torch.cuda.is_available(), 'CUDA unavailable'
assert hasattr(Qwen3TTSModel, 'generate_voice_design')
root = Path(__file__).resolve().parents[1]
data = {'python': sys.version, 'executable': sys.executable, 'torch': torch.__version__, 'torchaudio': torchaudio.__version__, 'qwen_tts': metadata.version('qwen-tts'), 'transformers': metadata.version('transformers'), 'attention': 'sdpa', 'device': torch.cuda.get_device_name(0), 'production_comfyui_modified': False}
(root / 'runtime/voice-design-environment.json').write_text(json.dumps(data, indent=2), encoding='utf-8')
print(json.dumps(data))
