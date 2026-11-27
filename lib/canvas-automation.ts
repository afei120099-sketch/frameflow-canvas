import type { Editor, TLShape } from "tldraw";
import { connectionWatchdog } from "./connection-watchdog.ts";
import { workflowBlockedReason } from "./h3-workflow-options.ts";
import { withCanvasBackgroundWork as pumped } from './canvas-background-work.ts';

/**
 * Canvas automation V0.1: `window.frameflow` for scripted control of the open canvas
 * (installed only when the dev server answers /__automation/ping; see scripts/automation-vite-plugin.ts).
 *
 * It only calls what the mouse UI already calls: the same image import, H3 node creation, connection,
 * node props and the H3 node's own generate() — so preflight, workflow blocking, GPU thermal gating,
 * Shot / Run / Asset records and recovery stay exactly as for a click. No ComfyUI request is made here.
 */

type Point = { x: number; y: number };
type Shape = TLShape & { props: Record<string, unknown> };
type FrameRole = "first" | "last" | "reference";

export type H3AutomationState = {
  generate: () => Promise<void>;
  /** Queue acceptance only; no waiting for rendering. */
  enqueue: (submissionControl?:'submit'|'automatic'|'chain',submissionSessionId?:string,signal?:AbortSignal) => Promise<{ runId: string; promptId: string }>;
  adopt: () => Promise<void>;
  /** Show a specific candidate (by Asset ID) in the node, as picking it in the candidate menu does. */
  choose: (assetId: string) => void;
  busy: boolean;
  status: string;
  stage?: string;
  error: string;
  elapsed: number;
  taskMode?: string;
  /** Only the controller rendered with the saved frame token may enqueue a dependent segment. */
  queueFrameToken?: string;
  preflight: { ok: boolean; errors: { message: string }[]; warnings?: { message: string }[] };
  compiledPrompt: string;
  batch: { index: number; count: number } | null;
  candidateCount: number;
  displayedAssetId?: string;
  adoptedAssetId?: string;
};

export type AutomationDeps = {
  addImageFile: (editor: Editor, file: File, point?: Point) => Promise<{ id: string }>;
  addVideoFile: (editor: Editor, file: File, point?: Point) => Promise<{ id: string } | undefined | void>;
  createH3Node: (editor: Editor, point: Point, props?: Record<string, unknown>) => Promise<{ id: string } | undefined>;
  connect: (editor: Editor, fromId: string, toId: string, role: FrameRole) => string;
  inputsOf: (editor: Editor, h3Id: string) => { first?: string; last?: string; references: string[] };
  h3Width: number;
};

const h3Controllers = new Map<string, () => H3AutomationState>();

/** Called by each mounted H3 node; returns the unregister function for its effect cleanup. */
export function registerH3Automation(id: string, read: () => H3AutomationState) {
  h3Controllers.set(id, read);
  return () => { if (h3Controllers.get(id) === read) h3Controllers.delete(id); };
}

/** Live state of a mounted H3 node. Null when the node is culled or not rendered yet. */
export function readH3Automation(id: string) {
  return h3Controllers.get(id)?.() ?? null;
}

const NODE_TYPES = new Set(["image-node", "h3-node", "video-node", "audio-node", "upscale-node", "smooth-node"]);
const ASPECTS = new Set(["follow", "16:9", "9:16", "1:1", "4:3", "3:4"]);
const SOUND = new Set(["av", "ambient", "silent"]);

function nodeOf(editor: Editor, id: string) {
  const shape = editor.getShape(id as TLShape["id"]) as Shape | undefined;
  if (!shape || !NODE_TYPES.has(shape.type)) throw new Error(`找不到节点 ${id}`);
  return shape;
}

function h3Of(editor: Editor, id: string) {
  const shape = nodeOf(editor, id);
  if (shape.type !== "h3-node") throw new Error(`${id} 不是 H3 节点`);
  return shape;
}

function round(value: number) { return Math.round(value); }

function h3State(id: string) {
  const read = h3Controllers.get(id);
  if (!read) return null;
  const state = read();
  return {
    busy: state.busy, status: state.status, stage: state.stage, error: state.error, elapsed: state.elapsed,
    taskMode: state.taskMode, preflightOk: state.preflight.ok,
    preflightErrors: state.preflight.errors.map((item) => item.message), preflightWarnings: (state.preflight.warnings ?? []).map((item) => item.message),
    batch: state.batch, candidateCount: state.candidateCount, displayedAssetId: state.displayedAssetId, adoptedAssetId: state.adoptedAssetId,
  };
}

function describe(editor: Editor, deps: AutomationDeps, shape: Shape, full = false) {
  const p = shape.props;
  const base = { id: shape.id, type: shape.type, name: (p.name as string) || undefined, x: round(shape.x), y: round(shape.y), w: round(p.w as number), h: round(p.h as number) };
  if (shape.type === "image-node") return { ...base, assetId: p.assetId, width: p.naturalWidth, height: p.naturalHeight };
  if (shape.type === "video-node") return { ...base, assetId: p.assetId, duration: p.duration, shotId: p.shotId };
  if (shape.type !== "h3-node") return base;
  const prompt = String(p.prompt ?? "");
  return {
    ...base,
    shotId: p.shotId,
    prompt: full || prompt.length <= 160 ? prompt : `${prompt.slice(0, 160)}…（${prompt.length} 字，用 get() 看全文）`,
    duration: p.duration, aspect: p.mode, soundMode: p.soundMode ?? "av", megapixels: p.megapixels, voiceRoleId: p.voiceRoleId, offscreenRoleIds:p.offscreenRoleIds, noBackgroundMusic:p.noBackgroundMusic,
    seedMode: p.seedMode, seed: p.seed, generationCount: p.generationCount ?? 1, workflowOptionId: p.workflowOptionId ?? "stable",
    inputs: deps.inputsOf(editor, shape.id),
    ...(full ? { compiledPrompt: h3Controllers.get(shape.id)?.().compiledPrompt } : {}),
    state: h3State(shape.id),
  };
}

/** Only these H3 props can be scripted; everything else (model, steps, LoRA, templates) stays frozen. */
function h3Patch(input: Record<string, unknown>) {
  const patch: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined) continue;
    switch (key) {
      case "prompt": if (typeof value !== "string") throw new Error("prompt 必须是文字"); patch.prompt = value; break;
      case "duration": { const seconds = Number(value); if (!Number.isFinite(seconds) || seconds <= 0) throw new Error("duration 必须是秒数"); patch.duration = String(seconds); break; }
      case "aspect": if (!ASPECTS.has(String(value))) throw new Error(`aspect 只能是 ${[...ASPECTS].join(" / ")}`); patch.mode = String(value); break;
      case "soundMode": if (!SOUND.has(String(value))) throw new Error("soundMode 只能是 av / ambient / silent"); patch.soundMode = value; break;
      case "megapixels": { const mp = Number(value); if (!Number.isFinite(mp) || mp < 0.1 || mp > 2) throw new Error("megapixels 超出范围"); patch.megapixels = mp; break; }
      case "seedMode": if (value !== "随机" && value !== "固定") throw new Error("seedMode 只能是 随机 / 固定"); patch.seedMode = value; break;
      case "seed": patch.seed = String(value); break;
      case "roleIds": {
        if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item)) throw new Error("roleIds 必须是角色 ID 数组");
        patch.roleIds = [...value];
        break;
      }
      case "offscreenRoleIds": if (!Array.isArray(value) || value.some(id=>typeof id!=="string" || !id)) throw new Error("offscreenRoleIds 必须是角色 ID 数组"); patch.offscreenRoleIds=[...value];break;
      case "noBackgroundMusic": if (typeof value!=="boolean") throw new Error("noBackgroundMusic 必须是布尔值");patch.noBackgroundMusic=value;break;
      case "voiceRoleId": if (typeof value !== "string") throw new Error("voiceRoleId 必须是角色 ID 字符串，空字符串表示关闭"); patch.voiceRoleId = value.trim(); break;
      case "generationCount": { const count = Number(value); if (!Number.isInteger(count) || count < 1 || count > 10) throw new Error("generationCount 只能是 1–10"); patch.generationCount = count; break; }
      case "ultimateKeyframes": if(typeof value!=="boolean")throw new Error("ultimateKeyframes 必须是布尔值");patch.ultimateKeyframes=value;break;
      case "workflowOptionId": { if (typeof value !== "string" || workflowBlockedReason(value)) throw new Error("工作流选择无法识别或不可用"); patch.workflowOptionId = value; break; }
      default: throw new Error(`不支持设置 ${key}（可设：prompt, duration, aspect, soundMode, megapixels, seedMode, seed, generationCount, roleIds, workflowOptionId）`);
    }
  }
  return patch;
}

async function fileFrom(source: { path?: string; url?: string; dataUrl?: string; name?: string }, fallbackName: string) {
  const url = source.path ? `/__automation/file?path=${encodeURIComponent(source.path)}` : source.url ?? source.dataUrl;
  if (!url) throw new Error("需要 path、url 或 dataUrl 之一");
  const response = await fetch(url);
  if (!response.ok) { const body = await response.json().catch(() => null) as { message?: string } | null; throw new Error(body?.message ?? `读取失败（HTTP ${response.status}）`); }
  const blob = await response.blob();
  const name = source.name ?? source.path?.split(/[\\/]/).pop() ?? fallbackName;
  return new File([blob], name, { type: blob.type });
}

/** Lets React re-render after a store change (setTimeout, not rAF: rAF never fires in a background tab). */
const settle = () => new Promise((done) => setTimeout(done, 150));

/*
 * Background-tab pump. tldraw flushes store listeners and shape re-renders on requestAnimationFrame, which the
 * browser pauses while the tab is hidden (e.g. Chrome behind another window) — a scripted connection would then
 * never reach the H3 node. While an automation call is running (and shortly after), every pending rAF callback in
 * a hidden tab also gets a timer fallback; whichever fires first runs it once. Visible tabs are unaffected.
 */
export function installCanvasAutomation(editor: Editor, deps: AutomationDeps) {
  const api = {
    version: "0.1",
    help: () => [
      "frameflow.list({ type? })                         画布上所有节点（位置、名字、H3 设置、连线、生成状态）",
      "frameflow.get(id)                                 单个节点完整信息（含完整提示词与实际提交的提示词）",
      "await frameflow.addImage({ path|url|dataUrl, name?, x?, y? })   导入图片（x,y 为中心点）",
      "await frameflow.addVideo({ path|url|dataUrl, name?, x?, y? })   导入 MP4",
      "await frameflow.createH3({ first?, last?, references?, x?, y?, prompt, duration, aspect, soundMode, megapixels, seedMode, seed, generationCount })",
      "await frameflow.setH3(id, { prompt, duration, ... })    修改 H3 设置",
      "await frameflow.connect(fromId, h3Id, 'first'|'last'|'reference') / await frameflow.disconnect(fromId, h3Id)",
      "角色：await frameflow.setH3(id, { roleIds: [roleId] })（多参考时绑定角色库里的人物 = <Subject N>）",
      "await frameflow.generate(id)                      等同点「生成视频」；先过生成前检查",
      "frameflow.status(id) / await frameflow.waitFor(id, timeoutMs?)",
      "await frameflow.adopt(id, assetId?)               采用当前显示的候选，或先切到指定候选再采用",
      "frameflow.move(id, x, y) / frameflow.focus(id)",
    ],
    list: (filter: { type?: string } = {}) => (editor.getCurrentPageShapes() as Shape[])
      .filter((shape) => NODE_TYPES.has(shape.type) && (!filter.type || shape.type === filter.type || shape.type === `${filter.type}-node`))
      .map((shape) => describe(editor, deps, shape)),
    get: (id: string) => describe(editor, deps, nodeOf(editor, id), true),
    addImage: async (source: { path?: string; url?: string; dataUrl?: string; name?: string; x?: number; y?: number }) => {
      const file = await fileFrom(source, "image.png");
      const point = source.x !== undefined && source.y !== undefined ? { x: source.x, y: source.y } : undefined;
      const shape = await deps.addImageFile(editor, file, point);
      return describe(editor, deps, nodeOf(editor, shape.id));
    },
    addVideo: async (source: { path?: string; url?: string; dataUrl?: string; name?: string; x?: number; y?: number }) => {
      const file = await fileFrom(source, "video.mp4");
      const before = new Set(editor.getCurrentPageShapeIds());
      const point = source.x !== undefined && source.y !== undefined ? { x: source.x, y: source.y } : undefined;
      await deps.addVideoFile(editor, file, point);
      const created = (editor.getCurrentPageShapes() as Shape[]).find((shape) => shape.type === "video-node" && !before.has(shape.id));
      return created ? describe(editor, deps, created) : null;
    },
    createH3: async (options: { first?: string; last?: string; references?: string[]; x?: number; y?: number } & Record<string, unknown>) => {
      const { first, last, references, x, y, ...settings } = options;
      const patch = h3Patch(settings);
      const anchor = first ? nodeOf(editor, first) : undefined;
      const point = x !== undefined && y !== undefined ? { x, y } : anchor ? { x: anchor.x + (anchor.props.w as number) + 130, y: anchor.y } : editor.getViewportPageBounds().center;
      const h3 = await deps.createH3Node(editor, point, patch);
      if (!h3) throw new Error("H3 节点创建失败");
      if (first) deps.connect(editor, first, h3.id, "first");
      if (last) deps.connect(editor, last, h3.id, "last");
      for (const reference of references ?? []) deps.connect(editor, reference, h3.id, "reference");
      await settle();
      return describe(editor, deps, h3Of(editor, h3.id), true);
    },
    setH3: async (id: string, settings: Record<string, unknown>) => {
      const shape = h3Of(editor, id);
      editor.updateShape({ id: shape.id, type: "h3-node", props: h3Patch(settings) } as never);
      await settle();
      return describe(editor, deps, h3Of(editor, id), true);
    },
    connect: async (fromId: string, toId: string, role: FrameRole = "first") => {
      nodeOf(editor, fromId); h3Of(editor, toId);
      if (!["first", "last", "reference"].includes(role)) throw new Error("role 只能是 first / last / reference");
      deps.connect(editor, fromId, toId, role);
      await settle();
      return deps.inputsOf(editor, toId);
    },
    disconnect: async (fromId: string, toId: string) => {
      nodeOf(editor, fromId); h3Of(editor, toId);
      const arrows = editor.getCurrentPageShapes().filter((shape) => {
        if (shape.type !== "arrow") return false;
        const ends = editor.getBindingsFromShape(shape, "arrow").map((binding) => binding.toId as string);
        return ends.includes(fromId) && ends.includes(toId);
      });
      editor.deleteShapes(arrows.map((arrow) => arrow.id));
      await settle();
      return { removed: arrows.length, inputs: deps.inputsOf(editor, toId) };
    },
    generate: async (id: string) => {
      const shape = h3Of(editor, id);
      // A node created / connected / edited just before must re-render first, or its generate() still holds the old
      // inputs; off-screen (culled) nodes do not re-render, so bring it into view and wait until its mode matches its inputs.
      const bounds = editor.getShapePageBounds(shape.id);
      if (bounds && !editor.getViewportPageBounds().contains(bounds)) editor.centerOnPoint(bounds.center, { animation: { duration: 0 } });
      const inputs = deps.inputsOf(editor, shape.id);
      const props = shape.props as { roleIds?: string[]; referenceImages?: unknown[]; referenceVideos?: unknown[]; referenceAudios?: unknown[] };
      const hasReferences = inputs.references.length > 0 || [props.roleIds, props.referenceImages, props.referenceVideos, props.referenceAudios].some((list) => (list?.length ?? 0) > 0);
      const expected = hasReferences ? (inputs.first && !inputs.last ? "ref2va" : undefined) : inputs.first && inputs.last ? "fl2va" : inputs.first ? "i2va" : inputs.last ? undefined : "t2va";
      let read = h3Controllers.get(shape.id);
      for (let attempt = 0; attempt < 20; attempt++) {
        await settle();
        read = h3Controllers.get(shape.id);
        if (read && (!expected || read().taskMode === expected)) break;
      }
      if (!read) throw new Error("H3 节点尚未在画布上渲染，请先 focus(id)");
      const state = read();
      if (expected && state.taskMode !== expected) return { started: false, reason: document.hidden ? "画布标签页在后台，浏览器暂停了画布刷新；请把画布切到前台后重试" : `节点模式（${state.taskMode}）与连线（${expected}）还未同步，请稍后重试` };
      if (state.busy) return { started: false, reason: "这个节点正在生成", state: h3State(shape.id) };
      if (!state.preflight.ok) return { started: false, reason: "生成前检查未通过", errors: state.preflight.errors.map((item) => item.message) };
      const submitted = { taskMode: state.taskMode, compiledPrompt: state.compiledPrompt };
      void state.generate();
      await settle();
      return { started: true, submitted, state: h3State(shape.id) };
    },
    status: (id: string) => { h3Of(editor, id); return h3State(id); },
    waitFor: async (id: string, timeoutMs = 10 * 60_000) => {
      h3Of(editor, id);
      const started = Date.now();
      while (Date.now() - started < timeoutMs) {
        const state = h3State(id);
        if (state && !state.busy) return state;
        await new Promise((done) => setTimeout(done, 2000));
      }
      return { timeout: true, state: h3State(id) };
    },
    adopt: async (id: string, assetId?: string) => {
      h3Of(editor, id);
      let read = h3Controllers.get(id);
      if (!read) throw new Error("H3 节点尚未在画布上渲染，请先 focus(id)");
      if (assetId && read().displayedAssetId !== assetId) {
        read().choose(assetId);
        for (let attempt = 0; attempt < 20 && read().displayedAssetId !== assetId; attempt++) { await settle(); read = h3Controllers.get(id) ?? read; }
        if (read().displayedAssetId !== assetId) throw new Error(`候选 ${assetId} 不属于这个镜头或尚未显示`);
      }
      await read().adopt();
      await settle();
      return h3State(id);
    },
    move: (id: string, x: number, y: number) => {
      const shape = nodeOf(editor, id);
      editor.updateShape({ id: shape.id, type: shape.type, x, y } as never);
      return describe(editor, deps, nodeOf(editor, id));
    },
    focus: (id: string) => {
      const shape = nodeOf(editor, id);
      editor.select(shape.id);
      editor.zoomToSelection({ animation: { duration: 200 } });
      return true;
    },
  };
  for (const name of ["addImage", "addVideo", "createH3", "setH3", "connect", "disconnect", "generate", "waitFor", "adopt", "move", "focus"] as const) {
    const original = api[name] as (...args: never[]) => unknown;
    (api as Record<string, unknown>)[name] = (...args: never[]) => pumped(() => original(...args));
  }
  (window as unknown as { frameflow?: typeof api }).frameflow = api;
  return () => { if ((window as unknown as { frameflow?: typeof api }).frameflow === api) delete (window as unknown as { frameflow?: typeof api }).frameflow; };
}

/** Keep the optional local control API available across startup/network/HMR failures. */
export function maintainCanvasAutomation(editor: Editor, deps: AutomationDeps) {
  const watchdog = connectionWatchdog({
    ready: () => Boolean((window as unknown as { frameflow?: unknown }).frameflow),
    connect: async signal => {
      const response = await fetch("/__automation/ping", { cache: "no-store", signal: AbortSignal.any([signal, AbortSignal.timeout(3000)]) });
      if (!response.ok || !(response.headers.get("content-type") ?? "").includes("application/json")) return null;
      const result = await response.json() as { ok?: boolean };
      if (signal.aborted || result.ok !== true) return null;
      // Another owner may have installed it while this request was in flight.
      if ((window as unknown as { frameflow?: unknown }).frameflow) return null;
      return installCanvasAutomation(editor, deps);
    },
  });
  const wake = () => { void watchdog.check(); };
  window.addEventListener("online", wake);
  window.addEventListener("focus", wake);
  return () => {
    window.removeEventListener("online", wake);
    window.removeEventListener("focus", wake);
    watchdog.stop();
  };
}
