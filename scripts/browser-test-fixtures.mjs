import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export function browserTestFixtures({ video = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'frameflow-browser-test-'));
  const image = join(dir, 'sample.png');
  writeFileSync(image, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg==', 'base64'));
  try {
    if (video) execFileSync(process.env.FRAMEFLOW_PYTHON || 'python', [fileURLToPath(new URL('./media-audit-fixtures.py', import.meta.url)), dir], { windowsHide: true, stdio: 'pipe' });
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    throw new Error('Video test fixture requires Python with PyAV and numpy (FRAMEFLOW_PYTHON)', { cause: error });
  }
  return { image, video: join(dir, 'black.mp4'), screenshot: name => join(dir, name), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
