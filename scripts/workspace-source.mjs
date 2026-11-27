// K1（2026-11-26）把 canvas-workspace.tsx 的状态栏、批量栏、端口、信息弹窗和共用函数搬到了 components/canvas/。
// 读主文件源码做检查的测试改用这里：主文件 + 搬出去的文件拼在一起，并去掉行首的 export，
// 这样按函数名截取源码、拿去 eval 的测试照旧能用。
import { readFileSync } from 'node:fs';

export const WORKSPACE_FILES = [
  'app/canvas-workspace.tsx',
  'components/canvas/workspace-shared.ts',
  'components/canvas/local-system-status.tsx',
  'components/canvas/batch-actions-bar.tsx',
  'components/canvas/workflow-port.tsx',
  'components/canvas/media-info-modals.tsx',
];

export function readWorkspaceSource() {
  const root = new URL('../', import.meta.url);
  return WORKSPACE_FILES
    .map((file) => readFileSync(new URL(file, root), 'utf8').replace(/^export (?=(async |default )?(function|const|let|type|interface|class) )/gm, ''))
    .join('\n');
}
