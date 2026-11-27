// 已停用的工作流（稳定版、视频延长、原音轨锁定视频）不能再从任何菜单或按钮建出来。
// A 批第 4 项（f720c47）清了「添加」菜单、快速创建和命令面板；这里补右键菜单和两个节点里的按钮。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const src = (rel) => readFileSync(path.join(root, rel), "utf8");

// 右键菜单：没有「原音轨锁定视频」，「AI音色设计」后面直接是「AI 作歌」
const context = src("components/canvas/flux-image-entry.tsx");
assert.doesNotMatch(context, /原音轨锁定视频|id="source-audio-video"|dispatchEvent\(new CustomEvent\(OPEN_AUDIO_VIDEO_EVENT/);
// 2026-11-12 右键菜单瘦身：名字在 lib/canvas-context-menu-plan.ts，「AI 工具 · 模板 ▸」里音色设计后面直接是作歌
const menuPlan = src("lib/canvas-context-menu-plan.ts");
assert.doesNotMatch(menuPlan, /原音轨锁定视频|source-audio-video/);
assert.match(menuPlan, /"text-to-voice", "music-generation"/);
assert.match(menuPlan, /"text-to-voice": "AI音色设计 · 试听选角",\n  "music-generation": "AI 作歌 · MiniMax Music 3"/);
// 作歌节点、音色设计节点：没有「用这首歌做视频」「用这段配音做视频」（它们建的就是原音轨锁定视频节点）
for (const rel of ["components/canvas/media-workshop-node.tsx", "components/canvas/tts-node.tsx"]) {
  const text = src(rel);
  assert.doesNotMatch(text, /用这首歌做视频|用这段配音做视频/, rel);
  assert.doesNotMatch(text, /onClick=\{\(\)=>createAudioVideoNode\(/, rel);
}
// 画布主文件：添加菜单、快速创建、命令面板、连线菜单都不再有这些入口（f720c47），这里一起守住
const ws = src("app/canvas-workspace.tsx");
assert.doesNotMatch(ws, /chooseQuickAction\("audio-video"\)|chooseAddAction\("audio-video"\)|label: "原音轨锁定视频/);
assert.doesNotMatch(ws, /chooseConnectionAction\("continue"\)/, "连线菜单没有「视频延长」");
assert.doesNotMatch(ws, /label="视频延长"|>视频延长</);
// 2026-11-11 清理：视频延长的建节点、提交、等来源代码都删了，只留旧节点显示、旧 Run 恢复和队列报错。
assert.doesNotMatch(ws, /"continue" \| "last-frame-video"|action === "continue"/, "连线菜单没有 continue 动作");
assert.doesNotMatch(ws, /videoAction === "extend"|workflowOptionId: "h3-extend"/, "画布不会再建视频延长节点");
assert.ok(!(await import("node:fs")).existsSync(path.join(root, "lib/comfyui/h3-extend.ts")), "视频延长工作流拼装已删除");
for (const rel of ["lib/comfyui/h3-adapter.ts", "lib/production-snapshots.ts", "components/use-shot-queue-execution.ts"]) assert.doesNotMatch(src(rel), /buildH3ExtendWorkflow|MiniMaxH3Extender|延长来源/, rel);
assert.match(src("lib/run-recovery.ts"), /H3_EXTEND_SAVE_NODE = "ff-extend-save"/, "旧延长 Run 仍能按原保存节点恢复");
console.log("retired entries: no 原音轨锁定视频 in the right-click menu or node buttons, no 视频延长 in menus; ok");
