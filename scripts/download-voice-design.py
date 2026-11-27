"""Download only the pinned official VoiceDesign model, verify weight hashes. No GPU."""
import hashlib
import json
import os
from pathlib import Path
import urllib.request
import shutil
os.environ['HF_HUB_DISABLE_XET'] = '1'

REPO = 'Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign'
REVISION = '5ecdb67327fd37bb2e042aab12ff7391903235d3'
root = Path(__file__).resolve().parents[1] / 'runtime/models/Qwen3-TTS-12Hz-1.7B-VoiceDesign'
with urllib.request.urlopen(f'https://huggingface.co/api/models/{REPO}/revision/{REVISION}?blobs=true', timeout=60) as response:
    metadata = json.load(response)
assert metadata['sha'] == REVISION
root.mkdir(parents=True, exist_ok=True)
print('Downloading pinned official model to', root, flush=True)
# Use short destination filenames, avoiding Windows MAX_PATH in hub's nested cache.
for entry in metadata['siblings']:
    if entry['rfilename'] == '.gitattributes':
        continue
    path = root / entry['rfilename']
    if path.exists() and path.stat().st_size == entry['size']:
        continue
    path.parent.mkdir(parents=True, exist_ok=True)
    print('Downloading', entry['rfilename'], entry['size'], flush=True)
    with urllib.request.urlopen(f'https://huggingface.co/{REPO}/resolve/{REVISION}/{entry["rfilename"]}', timeout=120) as response, path.with_suffix(path.suffix + '.part').open('wb') as target:
        shutil.copyfileobj(response, target, length=8 * 1024 * 1024)
    path.with_suffix(path.suffix + '.part').replace(path)
files = []
for entry in metadata['siblings']:
    if entry['rfilename'] == '.gitattributes':
        continue
    path = root / entry['rfilename']
    if path.stat().st_size != entry['size']:
        raise RuntimeError('Size mismatch: ' + entry['rfilename'])
    digest = hashlib.sha256()
    with path.open('rb') as source:
        for chunk in iter(lambda: source.read(8 * 1024 * 1024), b''):
            digest.update(chunk)
    actual = digest.hexdigest()
    expected = entry.get('lfs', {}).get('sha256')
    if expected and actual != expected:
        raise RuntimeError('SHA256 mismatch: ' + entry['rfilename'])
    files.append({'file': entry['rfilename'], 'bytes': path.stat().st_size, 'sha256': actual, 'official_sha256': expected})
    print('Verified', entry['rfilename'], flush=True)
(root / 'frameflow-source.json').write_text(json.dumps({'repo': REPO, 'revision': REVISION, 'license': metadata.get('cardData', {}).get('license'), 'files': files, 'total_bytes': sum(f['bytes'] for f in files)}, indent=2), encoding='utf-8')
print('PASS: official files downloaded and all weight SHA256 checks match.', flush=True)
