"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { ArrowDown, ArrowUp, ChevronDown, ChevronRight, ClipboardCopy, Columns2, Copy, Crosshair, Image as ImageIcon, Link2, Maximize2, Play, Trash2, X } from "lucide-react";
import { useImageThumbnail } from "@/components/canvas/use-image-thumbnail";
import { getAsset, listRuns, listShots, type AssetRecord } from "@/lib/production-records";
import { acquireMediaUrl, releaseMediaUrl } from "@/lib/local-video-store";
import { getPoster } from "@/lib/poster-cache";
import { RoughCutDialog } from "@/components/rough-cut-dialog";
import { clearKeyframeJobs, copyCandidates, copyQueueCandidates, dismissLostKeyframeJobs, enqueueKeyframes, keyframeJobs, loadCandidates, lostKeyframeJobs, setRejected, subscribeKeyframeJobs, type CandidateBook, type KeyframeJob } from "@/lib/shot-card-keyframes";
import { keyframeCount, type KeyframeDefaults } from "@/lib/shot-queue-keyframe";
import { canvasCutList } from "@/lib/canvas-rough-cut";
import { adoptShotAsset } from "@/lib/production-records";
import { readH3Automation } from "@/lib/canvas-automation";
import { planShotReferences as planRefs, shotQueueH3Props } from "@/lib/shot-queue";
import { dependentsOf, duplicateTitles, pinRelativeReferences } from "@/lib/shot-card-structure";
import { SHOT_CARD_GUIDE } from "@/lib/shot-card-guide";
import { listRoles, type RoleRecord } from "@/lib/role-records";
import { isTypingTarget } from "@/lib/keyboard-guards";
import { copyPlainText } from "@/lib/copy-plain-text";
import { refIds } from "@/lib/shot-card-viewer";
import { planShotReferences, queueGeneration, shotQueueMegapixels, type ShotQueue, type ShotQueueShot } from "@/lib/shot-queue";
import { queueFrameDescription } from "@/lib/shot-queue-frames";
import { calculateH3Dimensions, getActualDuration } from "@/lib/comfyui/h3-parameters";
import { namesMusic, type ShotCheck } from "@/lib/shot-card-checks";
import { h3qFix, parseH3qOutput, type H3qReport } from "@/lib/h3q-report";
import { runH3qCheck } from "@/lib/zhengben-client";
import { loadRecentQueuePaths, looksLikeJsonPath, readQueuePath, rememberQueuePath, rememberTableForQueue } from "@/lib/queue-path-load";
import { roleLines, setRoleLines, linesFromText, planDialogueImport, applyDialogueImport, importSummary } from "@/lib/shot-role-lines";
import { shotCardChecks } from "@/lib/shot-card-report";
import { dialogueFieldToRow, removeMusicSentences } from "@/lib/shot-card-fixes";
import { parseDialogueRow } from "@/lib/dialogue-row";
import { letterVersions, pickChosenVersion, type Lettered } from "@/lib/shot-card-videos";
import { listAssets } from "@/lib/production-records";
import { askConfirm } from "@/components/in-page-dialog";
import { shotEstimate, queueEstimate, keyframeEstimate, formatEstimate, shortEstimate, ESTIMATE_NOTE, type ShotEstimate } from "@/lib/shot-time-estimate";
import { queueCompleteness, type CategoryResult } from "@/lib/prompt-completeness";
import { CompletenessRow, CompletenessDetail, completenessDigest, type GateVerdict } from "@/components/shot-card-completeness";
import { EpisodePanel, EpisodePrompt, episodeCategories, episodeFoldSummary, EPISODE_STYLE } from "@/components/shot-card-episode";
import { attachEpisodeH3qItems, shotQueueJson, type EpisodeSettings } from "@/lib/episode-settings";
import { ScFoldBar, ScMoreMenu, openFold, SC_HEADER_STYLE } from "@/components/shot-card-header";
import { useCardUndoKeys } from "@/components/use-card-undo-keys";
import { H3Q_FIVE_SINCE, h3qChecksFive, h3qGateCategory, shotGate, shotGateMessage, type GateBasis } from "@/lib/shot-gate";
import { hardRuleById, withFixes } from "@/lib/hard-rules";
import { isOfficialFormat, officialCuts, officialDialogueLines, officialSections, officialSubjects, subjectsByPicture, OFFICIAL_MUSIC_NOTE } from "@/lib/official-format";
import { OFFICIAL_LINES_EDIT } from "@/lib/dialogue-row";
import { isGateCategory } from "@/lib/shot-gate";
import type { CategoryId } from "@/lib/zhengben-categories";
import type { H3qItem } from "@/lib/h3q-report";
import { useGateConfirmations, type GateRowCtx } from "@/components/use-gate-confirmations";
import { describeQueueChange, type UndoIntent } from "@/lib/shot-card-undo";
import { PresetPicker, PRESET_STYLE, type PresetCtx } from "@/components/shot-card-presets";
import { OFFICIAL_PRESET_NOTE, planEpisodePreset, planShotPreset, type PresetEdit } from "@/lib/zhengben-presets";
import { REVIEW_STYLE, ReviewDetail, reviewDigest, ReworkNoteBar, useReviewBook, VideoReview } from "@/components/shot-card-review";
import { EXPERIMENT_STYLE, ExperimentCompare, ExperimentDialog } from "@/components/shot-card-experiment";
import { experimentContext } from "@/lib/ab-experiment";
import { RefImageViewer, ShotVideoViewer, VIEWER_STYLE } from "@/components/shot-card-video-viewer";
import { DemixCardControl, DEMIX_CARD_STYLE, runEpisodeDemix } from "@/components/shot-card-demix";
import { useDemixRow } from "@/components/canvas/canvas-demix";
import { AI_COPY_STYLE, AiCopyButton, useAiCopy } from "@/components/shot-card-ai-copy";
import type { AiCopyShot } from "@/lib/shot-card-ai-copy";
import { musicRemovalPassesOf } from "@/lib/music-removal";
import { queueUsesKeyframes } from "@/lib/shot-card-view-rules";
import { applyChainHint, chainHintOf, type ChainHint } from "@/lib/shot-card-chain";
import { RenderStatusTile, RENDER_STATUS_STYLE, useRenderStatuses, type RenderInfo } from "@/components/shot-card-render-status";
import { T2V_NOTE, T2V_TITLE, t2vDescription, type T2vRow } from "@/lib/shot-card-t2v";
import { referenceCellText, referenceProblems, type RefProblem } from "@/lib/shot-card-ref-help";
import { cardHealth, healthDigest, rawShotHealth, type CardHealth, type HealthEntry } from "@/lib/shot-card-health";
import { canStepSeconds, durationAdviceOf, episodeMpState, mpPreset, MP_PRESETS, planDurationFixes, planEpisodeMegapixels, stepSeconds, withMegapixels, type DurationAdvice, type MpPreset } from "@/lib/shot-card-duration";
import { breakdownShotPrompt, CLAUSE_KIND_LABEL, nameSubjects, promptSegments, replaceSegments, type ClauseKind, type ClauseOverrides, type ShotBreakdown } from "@/lib/shot-card-breakdown";

/**
 * 镜头卡片：队列 JSON 检查通过后，每镜一张卡。核对和修改队列文本；只有「渲染这一镜」「出关键帧」或在卡片顶栏「JSON / 进度」抽屉里入队才提交显卡。
 * Picture 编号用 planShotReferences —— 和队列建节点时同一个函数，所以编号与实际提交一致。
 */

const OVERRIDES_KEY = "frameflow.shotCard.clauseOverrides.v1";
const readOverrides = (): Record<string, ClauseKind> => { try { return JSON.parse(localStorage.getItem(OVERRIDES_KEY) || "{}"); } catch { return {}; } };
const IGNORES_KEY = "frameflow.shotCard.ignoredChecks.v1";
const readIgnores = (): Record<string, string[]> => { try { return JSON.parse(localStorage.getItem(IGNORES_KEY) || "{}"); } catch { return {}; } };
const writeIgnores = (value: Record<string, string[]>) => { try { localStorage.setItem(IGNORES_KEY, JSON.stringify(value)); } catch { /* per-browser convenience only */ } };
const writeOverrides = (value: Record<string, ClauseKind>) => { try { localStorage.setItem(OVERRIDES_KEY, JSON.stringify(value)); } catch { /* per-browser convenience only */ } };

const WORKFLOW_LABEL: Record<string, string> = { ultimate: "终极版", fast: "极速版" };
const MODE_LABEL: Record<string, string> = { auto: "多参考", "first-last": "首尾帧", extend: "延长" };
const SOUND_LABEL: Record<string, string> = { av: "有声（av）", ambient: "只要环境声", silent: "静音" };

type RoleView = { roleId: string; name: string; appearance: AssetRecord | null; voice: AssetRecord | null; offscreen: boolean; speaks: boolean; missing: boolean };
type PictureView = { label: string; name: string; src: string; /** 官方格式：subject_definitions 里用这张图定义的 <Subject N>，例如「Subject 2」 */ subjects?: string; /** 角色图：角色 ID */ roleId?: string; /** 图片素材 ID（场景图 / 角色外观图） */ assetId?: string };
type CardModel = {
  key: string; chapter: number; index: number; shot: ShotQueueShot; breakdown: ShotBreakdown;
  requested: number; actual: number; frames: number; megapixels: number; size: { width: number; height: number } | null;
  workflow: string; noBgm: boolean; /** 正文是官方 Ref2VA 六段式（lib/official-format.ts） */ official: boolean; pictures: PictureView[]; refError: string; roles: RoleView[];
  /** 参考图 / ID 问题说人话（哪项错、JSON 还是画布的问题、怎么改） */
  refProblems: RefProblem[];
  /** 画面五项判定（h3q 为准，没跑成画布兜底）；h3qItems = 这一镜的 h3q 结果，h3q 没用上时是 null。卡片列表里算好再放进来。 */
  gate?: GateVerdict; h3qItems?: H3qItem[] | null;
  /** 正本 h3q「[时长]」提醒（只提醒，不拦截）；h3q 没跑成或这一镜没有就是 null */
  durationAdvice?: DurationAdvice | null;
  /** 正本 h3q「[接尾帧]」提示（只提示）；h3q 没跑成或这一镜没有就是 null（lib/shot-card-chain.ts） */
  chainHint?: ChainHint | null;
  /** 程序体检原始提示（带 code）；health = 和 h3q / 卡片去重后的（卡片列表里算） */
  healthRaw: HealthEntry[]; health?: CardHealth;
  dialogue: string[]; warnings: string[]; problems: string[]; overflow: number; relation: string; checks: ShotCheck[];
  /** Subject N → role name (roleIds order), and each role's dialogue lines for its "X speaks" beat. */
  names: string[]; linesByName: Record<string, string[]>;
  option: ReturnType<typeof queueGeneration>;
};

const promptDialogue = (prompt: string) => [...prompt.matchAll(/<d>\s*(?:\[[^\]]*\])?\s*([\s\S]*?)<\/d>/g)].map((m) => m[1].trim()).filter(Boolean);

function buildCard(queue: ShotQueue, chapter: number, index: number, roles: RoleRecord[], assets: Map<string, AssetRecord>, overrides: ClauseOverrides): CardModel {
  const shot = queue.chapters[chapter].shots[index];
  const breakdown = breakdownShotPrompt(shot.prompt, overrides);
  const duration = getActualDuration(shot.seconds);
  const megapixels = shotQueueMegapixels(shot, queue.defaults);
  const option = queueGeneration(shot, queue.defaults);
  const size = calculateH3Dimensions(0, 0, shot.aspect, megapixels, 32);
  const problems: string[] = [];

  const speakerIds = new Set([...(shot.dialogue ?? []).flatMap((line) => line.roleId ? [line.roleId] : []), ...(shot.voiceRoleId ? [shot.voiceRoleId] : [])]);
  const roleViews: RoleView[] = shot.roleIds.map((roleId) => {
    const role = roles.find((item) => item.roleId === roleId);
    const appearance = role?.primaryAppearanceAssetId ? assets.get(role.primaryAppearanceAssetId) ?? null : null;
    const voice = role?.primaryVoiceAssetId ? assets.get(role.primaryVoiceAssetId) ?? null : null;
    const view = { roleId, name: role?.displayName ?? roleId, appearance, voice, offscreen: Boolean(shot.offscreenRoleIds?.includes(roleId)), speaks: speakerIds.has(roleId), missing: !role };
    if (!role) problems.push(`角色不存在：${roleId}`);
    else if (!view.offscreen && !appearance) problems.push(`${view.name} 未绑外观`);
    return view;
  });

  let pictures: PictureView[] = [];
  let refError = "";
  const refProblems = referenceProblems(shot, roles, assets);
  try {
    const plan = planShotReferences(shot, roles, assets);
    pictures = plan.pictures.map((picture) => {
      const roleName = picture.name.startsWith("角色 ") ? picture.name.slice(3) : "";
      const role = roleName ? roleViews.find((item) => item.name === roleName) : undefined;
      const scene = picture.name.startsWith("场景 ") ? plan.scenes.find((item) => item.name === picture.name.slice(3)) : undefined;
      return { ...picture, src: role?.appearance?.storageReference ?? scene?.src ?? "", ...(role ? { roleId: role.roleId } : {}), ...((role?.appearance?.assetId ?? scene?.assetId) ? { assetId: role?.appearance?.assetId ?? scene?.assetId } : {}) };
    });
  } catch (cause) {
    refError = cause instanceof Error ? cause.message : "参考图核对失败";
    if (!problems.some((problem) => refError.includes(problem.split(" ")[0]))) problems.push(refError);
  }

  // 官方格式：<Subject N> 是谁按 subject_definitions 推（来自哪张 <Picture>，那张图是谁）；台词按 <d> 列出说话人编号。
  const official = isOfficialFormat(shot.prompt);
  if (official) {
    const bySubject = subjectsByPicture(shot.prompt);
    pictures = pictures.map((picture, i) => { const subjects = bySubject.get(i + 1); return subjects?.length ? { ...picture, subjects: subjects.map((s) => `Subject ${s.index}`).join("、") } : picture; });
  }
  const whoOfSubject = (n: number) => { const subject = officialSubjects(shot.prompt).find((s) => s.index === n); const picture = subject?.pictures.length ? pictures[subject.pictures[0] - 1] : undefined; return picture ? picture.name.replace(/^(角色|场景|首帧|尾帧) /, "") : null; };
  const dialogue = official ? officialDialogueLines(shot.prompt, whoOfSubject) : shot.dialogue?.length
    ? shot.dialogue.map((line) => `${line.roleId ? roleViews.find((role) => role.roleId === line.roleId)?.name ?? line.roleId : line.speaker ?? "?"}：${line.text}`)
    : breakdown.dialogue.length ? breakdown.dialogue : promptDialogue(shot.prompt);
  const lastEnd = breakdown.beats.reduce((max, beat) => Math.max(max, beat.end), 0);
  const overflow = lastEnd > duration.actualSeconds + 0.05 ? lastEnd : 0;
  // 程序体检：每镜那部分（不含「本集设定」整集提示：单镜算会把别的镜用到的设定误报成「整集没有一镜用到」）。
  const healthRaw = rawShotHealth(shot, queue.defaults);
  const warnings = healthRaw.map((entry) => entry.message);
  const relation = [queueFrameDescription(shot), shot.sourceShot ? `延长←${shot.sourceShot}` : ""].filter(Boolean).join("；");
  const names = roleViews.map((role) => role.name);
  // 台词 live in the prompt's 对白 row (正本「第一集写法」); an old queue's dialogue field is shown too, and flagged red.
  const linesByName: Record<string, string[]> = {};
  for (const entry of parseDialogueRow(shot.prompt).entries) (linesByName[entry.speaker] ??= []).push(entry.text);
  for (const line of shot.dialogue ?? []) {
    const name = line.roleId ? roleViews.find((role) => role.roleId === line.roleId)?.name ?? line.roleId : line.speaker ?? "";
    (linesByName[name] ??= []).push(line.text);
  }
  return {
    key: `${chapter}:${index}`, chapter, index, shot, breakdown,
    requested: shot.seconds, actual: duration.actualSeconds, frames: duration.length, megapixels, size,
    workflow: `${WORKFLOW_LABEL[option.workflow] ?? option.workflow} · ${MODE_LABEL[option.generationMode] ?? option.generationMode}${option.tuning === "understanding" ? " · 理解优先" : ""}`,
    noBgm: Boolean(queue.defaults?.noBackgroundMusic), official, pictures, refError, refProblems, roles: roleViews, dialogue, healthRaw, warnings, problems, overflow, relation, names, linesByName, option,
    // Same function the inbox uses for *_status.json, so other tools/AIs see exactly what the card shows.
    checks: shotCardChecks(shot, queue, roles, assets, overrides),
  };
}

/** 参考图分组：角色一行，其余（场景图、首帧、尾帧）归「场景」一行。 */
const REF_GROUPS = [{ id: "scene", label: "场景" }, { id: "role", label: "角色" }] as const;
const refGroupOf = (name: string): "scene" | "role" => name.startsWith("角色 ") ? "role" : "scene";

function Thumb({ src, label, tag, onOpen, ids = [] }: { src: string; label: string; tag: string; onOpen?: () => void; ids?: { kind: string; id: string }[] }) {
  const url = useImageThumbnail(src, 200).url;
  const frame = <div className="sc-frame">{url ? <img src={url} alt={label} draggable={false} /> : <ImageIcon size={16} />}<i>{tag}</i></div>;
  // 悬停看 ID；右键或小图标复制第一个 ID（角色图 = 角色 ID，场景图 = 图片 ID），放大层里能分别复制
  const first = ids[0];
  const copyId = () => { if (first) void copyPlainText(first.id, `已复制${first.kind}`); };
  return <figure className="sc-thumb" title={`${tag} · ${label}${ids.map((item) => `\n${item.kind}：${item.id}`).join("")}${onOpen ? "\n点一下放大看" : ""}${first ? `\n右键复制${first.kind}` : ""}`} onContextMenu={first ? (event) => { event.preventDefault(); copyId(); } : undefined}>
    {onOpen ? <button type="button" className="sc-thumb-zoom" aria-label={`放大看 ${tag} ${label}`} onClick={onOpen}>{frame}</button> : frame}
    <figcaption>{first && <button type="button" className="sc-thumb-id" aria-label={`复制 ${tag} 的${first.kind}`} title={`复制${first.kind}：${first.id}`} onClick={copyId}><ClipboardCopy aria-hidden="true" /></button>}{label}</figcaption>
  </figure>;
}

/** One clause; click to move it to another box. The choice is remembered for identical text. */
function Clause({ text, kind, onMove, names, prefix = "" }: { text: string; kind: ClauseKind; onMove: (text: string, kind: ClauseKind) => void; names: string[]; prefix?: string }) {
  const [open, setOpen] = useState(false);
  return <span className={`sc-clause ${open ? "open" : ""}`}>
    <button type="button" className="sc-clause-text" title="点一下可以挪到别的格子" onClick={() => setOpen((value) => !value)}>{prefix && <b className="sc-final">{prefix}</b>}{nameSubjects(text, names)}</button>
    {open && <span className="sc-move">挪到{(Object.keys(CLAUSE_KIND_LABEL) as ClauseKind[]).filter((target) => target !== kind).map((target) => <button type="button" key={target} onClick={() => { onMove(text, target); setOpen(false); }}>{CLAUSE_KIND_LABEL[target]}</button>)}</span>}
  </span>;
}

/** "EP02-office-v4-L03｜抬头等她过来" → { code: "L03", name: "抬头等她过来" }. */
function splitTitle(title: string, index: number) {
  const [head, ...rest] = title.split(/[｜|]/);
  const code = rest.length ? head.split(/[-_\s]/).filter(Boolean).pop() ?? head : String(index + 1).padStart(2, "0");
  // 对比实验复制出来的 ·对比A / ·对比B 两镜，镜号后面带上 A / B，不然两张卡看起来是同一镜。
  const pair = /·对比(\d*)([AB])$/.exec(title);
  const base = code.length > 8 ? String(index + 1).padStart(2, "0") : code;
  return { code: pair ? `${base}·${pair[1]}${pair[2]}` : base, name: rest.length ? rest.join("｜") : title };
}

/** One rendered video of this shot, from an H3 node on this canvas page made for it. stale = the node's prompt differs from the card. */
/** label / letter / reviewLabel：lib/shot-card-videos.ts letterVersions（去配乐版不占新字母）。 */
type VideoVersion = Lettered & { assetId: string; asset: AssetRecord; shotId: string; nodeId: string; adopted: boolean; adoptedAt?: number; stale: boolean; createdAt: number; /** Run.zhengbenVersion：按哪一版正本写的 */ zhengben?: string };
type ShotVideos = { versions: VideoVersion[]; chosen: VideoVersion | null };
/** What the card needs from the canvas page (supplied by the 队列 panel). */
export type CardCanvas = {
  pageShots: () => { nodeId: string; title: string; prompt: string; shotId: string }[];
  createNode: (props: Record<string, unknown>) => Promise<{ id: string } | undefined>;
  focus: (id: string, moveCamera?: boolean) => void;
};

/** Rendered video: loads only on click (47 pinned video blobs would eat memory). */
function VideoTile({ videos, aspect, onChoose, extra, onZoom, demix, render }: { videos: ShotVideos | null; aspect: string; onChoose: (version: VideoVersion) => void; extra?: ReactNode; onZoom?: () => void; demix?: ReactNode; /** 正在 ComfyUI 里排队 / 渲染（components/shot-card-render-status.tsx） */ render?: RenderInfo }) {
  const [url, setUrl] = useState("");
  const [playing, setPlaying] = useState("");
  const keyRef = useRef<string | null>(null);
  useEffect(() => () => releaseMediaUrl(keyRef.current), []);
  const ratio = aspect.replace(":", "/");
  const chosen = videos?.chosen ?? null;
  if (!videos || !chosen) return render ? <RenderStatusTile info={render} aspect={aspect} /> : <div className="sc-video empty" style={{ aspectRatio: ratio }}><span>还没渲染</span></div>;
  const source = chosen.asset.storageReference;
  const poster = getPoster(source);
  const play = () => { releaseMediaUrl(keyRef.current); keyRef.current = null; void acquireMediaUrl(source).then((media) => { keyRef.current = media.key; setUrl(media.url); setPlaying(chosen.assetId); }).catch(() => setUrl("")); };
  return <div className="sc-video-wrap">
    {render && <RenderStatusTile info={render} compact />}
    {/* A/B/C 只按真正出片的算；去配乐版在下面「看去配乐版 / 切回原声」里切换 */}
    {videos.versions.filter((version) => version.owner).length > 1 && <div className="sc-versions" role="radiogroup" aria-label="选用哪一条">{videos.versions.filter((version) => version.owner).map((version) => <button type="button" key={version.assetId} role="radio" aria-checked={version.letter === chosen.letter} className={`${version.letter === chosen.letter ? "on" : ""} ${version.stale ? "stale" : ""}`} title={`${version.stale ? "旧提示词出的；" : ""}${version.adopted ? "已采用" : "点一下选用这一条（粗剪也用它）"}`} onClick={() => version.letter !== chosen.letter && onChoose(version)}>{version.label}</button>)}</div>}
    <div className={`sc-video ${chosen.stale ? "stale" : ""}`} style={{ aspectRatio: ratio }}>
      {url && playing === chosen.assetId ? <video src={url} controls autoPlay playsInline /> : <button type="button" onClick={play} style={poster ? { backgroundImage: `url(${poster})` } : undefined}><Play size={20} /><span>播放 {chosen.label}</span></button>}
      <i>{chosen.stale ? "旧提示词" : chosen.adopted ? "★ 已采用" : "最新"}</i>
      {onZoom && <button type="button" className="sc-zoom" aria-label="放大看视频" title="放大看（左右切换上一镜 / 下一镜）" onClick={onZoom}><Maximize2 size={14} /></button>}
    </div>
    <small className="sc-zhengben" title="出这条视频时记录的正本版本（%FRAMEFLOW_H3_TOOLS%/SKILL_h3-video.md 开头「正本 v…」）">{chosen.zhengben ? `按正本 ${chosen.zhengben}` : "正本版本未记录（旧视频）"}</small>
    {demix}
    {extra}
  </div>;
}


/* ── 编辑：改的是队列 JSON 里的这一镜，保存时整份队列重新检查 ── */
type EditCtx = { /** 画面五项被拦时的「我确认没问题」 */ gate?: GateRowCtx; episode?: EpisodeSettings; roles: RoleRecord[]; images: () => Promise<AssetRecord[]>; assets: Map<string, AssetRecord>; locked: string; save: (shot: ShotQueueShot) => string | null;
  /** Structural edits (copy / delete / move). Refused once the queue has submitted rows, since row status is kept by position. */
  duplicate: () => string | null; remove: () => string | null; shift: (delta: -1 | 1) => string | null; structureLocked: string; startEditing: boolean;
  /** 先出关键帧 */
  render: () => Promise<string | null>; chainFromTail: () => Promise<string | null>; chainUp: () => string | null; canRender: string; choose: (version: VideoVersion) => Promise<string | null>;
  candidates: KeyframeCandidateView[]; jobs: KeyframeJob[]; keyframeDefaults?: KeyframeDefaults; runKeyframes: (count?: number) => string | null; approve: (assetId: string | null) => Promise<string | null>; reject: (assetId: string, rejected: boolean) => void;
  /** 预计耗时（估算）for this shot. */
  estimate: ShotEstimate;
  /** The lock right now (the page keeps running while a question is open). */
  lockNow: () => string;
  /** 一键选预设（完整度标签里点开） */
  preset: PresetCtx;
  /** 审片标记（视频下面） */
  review?: (videos: ShotVideos) => ReactNode;
  /** 对比实验（复制成 A / B，只改一段，同一种子） */
  experiment?: () => void;
  /** 放大看视频 */
  zoom?: () => void;
  /** 放大看参考图（P 编号） */
  zoomRef?: (tag: string) => void;
  /** 视频下面的去配乐按钮 */
  demix?: (videos: ShotVideos) => ReactNode;
  /** 只复制这一镜的问题给 AI */
  copyForAi?: () => void;
  /** 一键定位到画布上已建好的节点（未建节点时为 undefined） */
  locate?: () => void };
type KeyframeCandidateView = { assetId: string; src: string; rejected: boolean };

function AutoText({ value, onChange, mono = false }: { value: string; onChange: (value: string) => void; mono?: boolean }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { const el = ref.current; if (el) { el.style.height = "auto"; el.style.height = `${el.scrollHeight + 2}px`; } }, [value]);
  return <textarea ref={ref} className={`sc-input ${mono ? "mono" : ""}`} rows={1} value={value} spellCheck={false} onChange={(event) => onChange(event.target.value)} />;
}

function ImagePicker({ load, exclude, onPick, onClose }: { load: () => Promise<AssetRecord[]>; exclude: ReadonlySet<string>; onPick: (asset: AssetRecord) => void; onClose: () => void }) {
  const [images, setImages] = useState<AssetRecord[] | null>(null);
  const [query, setQuery] = useState("");
  useEffect(() => { void load().then(setImages).catch(() => setImages([])); }, [load]);
  const list = (images ?? []).filter((asset) => !exclude.has(asset.assetId) && (!query || asset.filename.toLowerCase().includes(query.toLowerCase())));
  return <div className="sc-picker">
    <div className="sc-picker-head"><input className="sc-input" placeholder="按文件名找场景图" value={query} onChange={(event) => setQuery(event.target.value)} autoFocus /><button type="button" className="sc-btn" onClick={onClose}>收起</button></div>
    {images === null ? <p className="muted">正在读取画布图片…</p> : list.length ? <div className="sc-picker-grid">{list.slice(0, 60).map((asset) => <button type="button" key={asset.assetId} title={asset.filename} onClick={() => onPick(asset)}><Thumb src={asset.storageReference} tag="+" label={asset.filename} /></button>)}</div> : <p className="muted">没有可选的图片</p>}
  </div>;
}

/** Free typing; the value is clamped and committed when the box loses focus (typing "12" no longer jumps to 5 after the "1"). */
function NumField({ value, min, max, step, placeholder, disabled, onCommit }: { value: number | undefined; min: number; max: number; step: number; placeholder?: string; disabled?: boolean; onCommit: (value: number | undefined) => void }) {
  const [text, setText] = useState(value === undefined ? "" : String(value));
  // Outside changes (another field, a fix) replace the text; done during render, not in an effect.
  const [seen, setSeen] = useState(value);
  if (seen !== value) { setSeen(value); setText(value === undefined ? "" : String(value)); }
  const commit = () => {
    if (text.trim() === "") { onCommit(undefined); return; }
    const n = Number(text);
    if (!Number.isFinite(n)) { setText(value === undefined ? "" : String(value)); return; }
    const clamped = Math.min(max, Math.max(min, step >= 1 ? Math.round(n) : n));
    setText(String(clamped)); onCommit(clamped);
  };
  return <input className="sc-input" type="number" inputMode="decimal" min={min} max={max} step={step} value={text} placeholder={placeholder} disabled={disabled} onChange={(event) => setText(event.target.value)} onBlur={commit} onKeyDown={(event) => { if (event.key === "Enter") commit(); }} />;
}

function ShotEditor({ card, ctx, onDone }: { card: CardModel; ctx: EditCtx; onDone: () => void }) {
  const original = card.shot;
  const [segments] = useState(() => promptSegments(original.prompt));
  const [texts, setTexts] = useState(() => segments.map((segment) => segment.text));
  const [draft, setDraft] = useState<ShotQueueShot>(() => structuredClone(original));
  const [picking, setPicking] = useState(false);
  const [pickingBoard, setPickingBoard] = useState(false);
  const [error, setError] = useState("");
  const patch = (next: Partial<ShotQueueShot>) => setDraft((current) => ({ ...current, ...next }));
  const roleName = (id: string) => ctx.roles.find((role) => role.roleId === id)?.displayName ?? id.slice(0, 8);
  const lines = draft.dialogue ?? [];
  const save = () => {
    if (ctx.locked) { setError(ctx.locked); return; }
    if (draft.keyframe && !draft.keyframe.prompt.trim()) { setError("关键帧描述还是空的；不想出关键帧就把勾去掉"); return; }
    try {
      const prompt = replaceSegments(original.prompt, segments, texts);
      const next: ShotQueueShot = { ...draft, prompt, ...(lines.length ? { dialogue: lines.filter((line) => line.text?.trim()) } : {}) };
      if (!lines.length) delete next.dialogue;
      const problem = ctx.save(next);
      if (problem) setError(problem); else onDone();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "保存失败"); }
  };
  const num = (value: string, min: number, max: number) => { const n = Number(value); return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : min; };

  return <div className="sc-editor">
    <div className="sc-edit-side">
      <h5>场景图（sceneAssetIds）</h5>
      <div className="sc-edit-thumbs">
        {draft.sceneAssetIds.map((id, i) => { const asset = ctx.assets.get(id); return <div key={id} className="sc-edit-thumb">
          <Thumb src={asset?.storageReference ?? ""} tag={`S${i + 1}`} label={asset?.filename ?? id.slice(0, 8)} />
          <div className="sc-mini-row">
            {i > 0 && <button type="button" title="往前挪" onClick={() => { const ids = [...draft.sceneAssetIds]; [ids[i - 1], ids[i]] = [ids[i], ids[i - 1]]; patch({ sceneAssetIds: ids }); }}>←</button>}
            <button type="button" title="去掉这张" onClick={() => patch({ sceneAssetIds: draft.sceneAssetIds.filter((x) => x !== id) })}>×</button>
          </div>
        </div>; })}
        {draft.sceneAssetIds.length < 6 && <button type="button" className="sc-add-thumb" onClick={() => setPicking(true)}>＋<span>加场景图</span></button>}
      </div>
      {picking && <ImagePicker load={ctx.images} exclude={new Set(draft.sceneAssetIds)} onClose={() => setPicking(false)} onPick={(asset) => { ctx.assets.set(asset.assetId, asset); patch({ sceneAssetIds: [...draft.sceneAssetIds, asset.assetId] }); setPicking(false); }} />}
      <h5>角色（roleIds）</h5>
      <div className="sc-edit-roles">
        {draft.roleIds.map((id) => { const off = Boolean(draft.offscreenRoleIds?.includes(id)); return <span key={id} className="sc-role-chip">
          {roleName(id)}
          <label title="只出声不出镜"><input type="checkbox" checked={off} onChange={(event) => patch({ offscreenRoleIds: event.target.checked ? [...(draft.offscreenRoleIds ?? []), id] : (draft.offscreenRoleIds ?? []).filter((x) => x !== id) })} />画外音</label>
          <button type="button" title="从这一镜去掉" onClick={() => { const next: ShotQueueShot = { ...draft, roleIds: draft.roleIds.filter((x) => x !== id), offscreenRoleIds: (draft.offscreenRoleIds ?? []).filter((x) => x !== id), dialogue: lines.filter((line) => line.roleId !== id) }; if (next.voiceRoleId === id) { delete next.voiceRoleId; delete next.autoVoiceAssigned; } if (next.keyframe?.faceRoleId === id) { const kf = { ...next.keyframe }; delete kf.faceRoleId; next.keyframe = kf; } setDraft(next); }}>×</button>
        </span>; })}
        <select className="sc-input" value="" onChange={(event) => { if (event.target.value) patch({ roleIds: [...draft.roleIds, event.target.value] }); }}>
          <option value="">＋ 加角色</option>
          {ctx.roles.filter((role) => !draft.roleIds.includes(role.roleId)).map((role) => <option key={role.roleId} value={role.roleId}>{role.displayName}{role.primaryAppearanceAssetId ? "" : "（缺外观）"}{role.primaryVoiceAssetId ? "" : "（缺声音）"}</option>)}
        </select>
      </div>
      <h5>先出关键帧（锁首帧，原生产线做法）</h5>
      {draft.firstFrameFrom ? <p className="muted">这一镜接上一镜的帧，首帧由接帧决定，不用出关键帧。</p> : <div className="sc-edit-kf">
        <label className="sc-check-line"><input type="checkbox" checked={Boolean(draft.keyframe)} onChange={(event) => { if (event.target.checked) patch({ keyframe: { prompt: "" } }); else { const next = { ...draft }; delete next.keyframe; setDraft(next); } }} />这一镜先出关键帧，挑一张当首帧</label>
        {draft.keyframe && <>
          <label><span>关键帧描述（英文，写外观、景别、构图；Flux 读不懂中文）</span><AutoText value={draft.keyframe.prompt} onChange={(value) => patch({ keyframe: { ...draft.keyframe!, prompt: value } })} /></label>
          <div className="sc-edit-params">
            <label><span>锁谁的脸</span><select className="sc-input" value={draft.keyframe.faceRoleId ?? ""} onChange={(event) => { const kf = { ...draft.keyframe! }; if (event.target.value) kf.faceRoleId = event.target.value; else delete kf.faceRoleId; patch({ keyframe: kf }); }}><option value="">不锁脸</option>{draft.roleIds.map((id) => <option key={id} value={id}>{roleName(id)}</option>)}</select></label>
            <label><span>锁脸强度</span><NumField value={draft.keyframe.faceWeight} min={0} max={1.5} step={0.05} placeholder="0.85" onCommit={(v) => { const kf = { ...draft.keyframe! }; if (v === undefined) delete kf.faceWeight; else kf.faceWeight = v; patch({ keyframe: kf }); }} /></label>
            <label><span>一次出几张</span><NumField value={draft.keyframe.count} min={1} max={6} step={1} placeholder="3" onCommit={(v) => { const kf = { ...draft.keyframe! }; if (v === undefined) delete kf.count; else kf.count = v; patch({ keyframe: kf }); }} /></label>
            <label><span>分镜深度强度</span><NumField value={draft.keyframe.depthStrength} min={0.3} max={1.5} step={0.05} placeholder="1" disabled={!draft.keyframe.storyboardAssetId} onCommit={(v) => { const kf = { ...draft.keyframe! }; if (v === undefined) delete kf.depthStrength; else kf.depthStrength = v; patch({ keyframe: kf }); }} /></label>
          </div>
          <div className="sc-edit-thumbs">
            {draft.keyframe.storyboardAssetId ? <div className="sc-edit-thumb"><Thumb src={ctx.assets.get(draft.keyframe.storyboardAssetId)?.storageReference ?? ""} tag="分镜" label="锁构图" /><div className="sc-mini-row"><button type="button" onClick={() => { const kf = { ...draft.keyframe! }; delete kf.storyboardAssetId; delete kf.depthStrength; patch({ keyframe: kf }); }}>×</button></div></div>
              : <button type="button" className="sc-add-thumb" onClick={() => setPickingBoard(true)}>＋<span>分镜图（可选）</span></button>}
          </div>
          {pickingBoard && <ImagePicker load={ctx.images} exclude={new Set()} onClose={() => setPickingBoard(false)} onPick={(asset) => { ctx.assets.set(asset.assetId, asset); patch({ keyframe: { ...draft.keyframe!, storyboardAssetId: asset.assetId } }); setPickingBoard(false); }} />}
        </>}
      </div>}
      <h5>参数</h5>
      <div className="sc-edit-params">
        <label><span>秒数</span><NumField value={draft.seconds} min={5} max={15} step={1} onCommit={(v) => patch({ seconds: v ?? 6 })} /></label>
        <label><span>像素 MP</span><NumField value={draft.megapixels} min={0.3} max={1} step={0.01} placeholder="队列默认" onCommit={(v) => { const next = { ...draft }; if (v === undefined) delete next.megapixels; else next.megapixels = v; setDraft(next); }} /></label>
        <label><span>比例</span><select className="sc-input" value={draft.aspect} onChange={(event) => patch({ aspect: event.target.value as ShotQueueShot["aspect"] })}>{["9:16", "16:9", "1:1", "4:3", "3:4"].map((value) => <option key={value}>{value}</option>)}</select></label>
        <label><span>声音</span><select className="sc-input" value={draft.soundMode} onChange={(event) => patch({ soundMode: event.target.value as ShotQueueShot["soundMode"] })}><option value="av">有声 av</option><option value="ambient">只要环境声</option><option value="silent">静音</option></select></label>
        <label><span>工作流</span><select className="sc-input" value={draft.workflow ?? ""} onChange={(event) => { const v = event.target.value; const next = { ...draft }; if (v) next.workflow = v as ShotQueueShot["workflow"]; else delete next.workflow; setDraft(next); }}><option value="">队列默认</option><option value="ultimate">终极版</option><option value="fast">极速版</option></select></label>
        <label><span>说话人（带主声音）</span><select className="sc-input" value={draft.autoVoiceDisabled ? "__off" : draft.voiceRoleId && !draft.autoVoiceAssigned ? draft.voiceRoleId : ""} onChange={(event) => { const v = event.target.value; const next: ShotQueueShot = { ...draft }; delete next.autoVoiceAssigned; delete next.voiceRoleId; delete next.autoVoiceDisabled; if (v === "__off") next.autoVoiceDisabled = true; else if (v) next.voiceRoleId = v; setDraft(next); }}><option value="">自动（按台词）</option>{draft.roleIds.filter((id) => !(draft.offscreenRoleIds ?? []).includes(id) || true).map((id) => <option key={id} value={id}>{roleName(id)}</option>)}<option value="__off">不带角色声音</option></select></label>
        <label><span>调参</span><select className="sc-input" value={draft.tuning ?? ""} onChange={(event) => { const v = event.target.value; const next = { ...draft }; if (v) next.tuning = v as ShotQueueShot["tuning"]; else delete next.tuning; setDraft(next); }}><option value="">队列默认</option><option value="default">原配置（快）</option><option value="understanding">理解优先（慢，动作准）</option></select></label>
      </div>
    </div>

    <div className="sc-edit-main">
      <h5>提示词（按段改，没动的段一字不变）</h5>
      <div className="sc-edit-segments">{segments.map((segment, i) => <label key={i} className={`sc-seg ${texts[i] !== segment.text ? "dirty" : ""}`}>
        <span>{segment.label}</span>
        <AutoText value={texts[i]} onChange={(value) => setTexts((current) => current.map((text, j) => j === i ? value : text))} />
      </label>)}</div>
      <p className="muted">台词写在上面「对白」那一段：对白（中文普通话，口型同步）：张三：“……” 李四：“……”。规则以正本 %FRAMEFLOW_H3_TOOLS%\SKILL_h3-video.md 为准。</p>
      {lines.length > 0 && <><h5>旧 dialogue 字段（正本要求留空）</h5>
      <div className="sc-edit-lines">
        <small className="dim">这 {lines.length} 句在 dialogue 字段里：出片时画布会追加中文角色名和声音录音，角色会喊名字、说乱话。保存后在卡片上点「把台词搬进正文对白」，或在这里删掉。</small>
        {lines.map((line, i) => <div key={i} className="sc-edit-line">
          <span className="sc-input">{line.roleId ? roleName(line.roleId) : line.speaker ?? "?"}：{line.text}</span>
          <button type="button" className="sc-btn" onClick={() => patch({ dialogue: lines.filter((_, j) => j !== i) })}>删</button>
        </div>)}
      </div></>}
      {error && <p className="sc-intake-error">{error}</p>}
      <div className="sc-edit-actions">
        <span className="muted">保存后写回队列 JSON（「JSON / 进度」抽屉里那份）；已经入队的节点不会跟着变。</span>
        <button type="button" className="sc-btn" onClick={onDone}>取消</button>
        <button type="button" className="sc-btn primary" onClick={save} disabled={Boolean(ctx.locked)} title={ctx.locked || undefined}>保存这一镜</button>
      </div>
    </div>
  </div>;
}

/** 关键帧列：候选、通过、再出。接上一镜尾帧的镜头首帧由接帧决定，这里只显示说明。 */
function KeyframeCell({ card, ctx, onEdit }: { card: CardModel; ctx: EditCtx; onEdit: () => void }) {
  const { shot } = card;
  const [note, setNote] = useState("");
  if (shot.firstFrameFrom) return <div className="sc-kf"><div className="sc-kf-chain">首帧接<br /><b>{shot.firstFrameFrom.shot ?? shot.firstFrameFrom.shotId ?? "上一镜"}</b><br />的{shot.firstFrameFrom.frame === "last" ? "尾" : "首"}帧</div></div>;
  const approved = shot.firstFrameAssetId ?? null;
  const approvedView = approved ? ctx.candidates.find((item) => item.assetId === approved) ?? { assetId: approved, src: ctx.assets.get(approved)?.storageReference ?? "", rejected: false } : null;
  const others = ctx.candidates.filter((item) => item.assetId !== approved);
  const running = ctx.jobs.filter((job) => job.state !== "failed");
  const failed = ctx.jobs.filter((job) => job.state === "failed");
  const act = (problem: string | null) => setNote(problem ?? "");
  if (!shot.keyframe && !approved) return <div className="sc-kf"><button type="button" className="sc-kf-add" disabled={Boolean(ctx.locked)} onClick={onEdit} title="给这一镜写关键帧描述，先出图挑首帧，再出视频">＋ 先出关键帧</button></div>;
  return <div className="sc-kf">
    {approvedView && <figure className="sc-kf-main">
      <div className="sc-frame"><KfImage src={approvedView.src} /><i>★ 首帧</i></div>
      <button type="button" className="sc-kf-mini" disabled={Boolean(ctx.locked)} onClick={() => void ctx.approve(null).then(act)}>取消首帧</button>
    </figure>}
    {others.length > 0 && <div className="sc-kf-cands">{others.map((item) => <figure key={item.assetId} className={item.rejected ? "rejected" : ""}>
      <div className="sc-frame"><KfImage src={item.src} /></div>
      <div className="sc-kf-acts">
        {!item.rejected && <button type="button" className="ok" disabled={Boolean(ctx.locked)} onClick={() => void ctx.approve(item.assetId).then(act)}>通过</button>}
        <button type="button" onClick={() => ctx.reject(item.assetId, !item.rejected)}>{item.rejected ? "恢复" : "弃"}</button>
      </div>
    </figure>)}</div>}
    {running.length > 0 && <p className="sc-kf-run">{running.length} 张排队/生成中 · {running.find((job) => job.state === "running")?.stage ?? "等前面的镜头"}</p>}
    {failed.length > 0 && <p className="sc-kf-fail" title={failed.map((job) => job.error).join("\n")}>{failed.length} 张失败：{failed[0].error?.slice(0, 60)}</p>}
    {shot.keyframe && <button type="button" className="sc-kf-go" disabled={Boolean(ctx.locked)} onClick={() => act(ctx.runKeyframes())}>{ctx.candidates.length ? "再出" : "出关键帧"} {keyframeCount(shot.keyframe, ctx.keyframeDefaults)} 张</button>}
    {note && <p className="sc-kf-fail">{note}</p>}
  </div>;
}

function KfImage({ src }: { src: string }) {
  const url = useImageThumbnail(src, 320).url;
  return url ? <img src={url} alt="" draggable={false} /> : <ImageIcon size={16} />;
}

/** Which checker said it: 「正本 h3q」 or 「画布」. */
function CheckSource({ check }: { check: ShotCheck }) {
  return <span className={`sc-src ${check.source === "h3q" ? "h3q" : ""}`} title={check.source === "h3q" ? "正本 h3q check 给的结果（%FRAMEFLOW_H3_TOOLS%/h3q.py），规则以正本为准" : "画布自己的检查（参考图、素材、时间轴这类正本 h3q 查不到的）"}>{check.source === "h3q" ? "正本 h3q" : "画布"}</span>;
}

/** 正本 h3q 的总状态：跑没跑成、哪一版正本、有没有核对对照表、和单镜无关的条目（一致性等）。 */
function H3qBar({ h3q, tableFile, setTableFile, rerun }: { h3q: H3qState; tableFile: string; setTableFile: (value: string) => void; rerun: () => void }) {
  const [draft, setDraft] = useState(tableFile);
  const [open, setOpen] = useState(false);
  useEffect(() => setDraft(tableFile), [tableFile]);
  const counts = h3q.report?.counts;
  const general = h3q.report?.general ?? [];
  // 正本 v2026-11-13：旧格式（第一集中文写法）停用。6f71917 是整份队列一条 WARN，v2026-11-13.1 起每镜一条 ERROR（照拦）——
  // 都在这里醒目地单独一行，不藏在「整集 N 条」里。
  const legacy = general.filter((item) => item.message.includes("[旧格式]"));
  const legacyShots = (h3q.report?.shots ?? []).filter((items) => items.some((item) => item.level === "ERROR" && item.message.includes("[旧格式]"))).length;
  return <div className={`sc-bulk sc-h3q ${h3q.state === "fail" ? "fail" : ""}`} role="status">
    {legacyShots > 0 && <div className="sc-h3q-legacy" role="alert"><b>旧格式</b>{legacyShots} 镜还是旧格式（第一集中文写法），正本 {h3q.version ?? ""} 已停用，这些镜头不能入队。照正本官方格式重写另存新版本（卡片「复制给 AI 修改」里有写法和范本）。</div>}
    {!legacyShots && legacy.map((item, i) => <div key={i} className="sc-h3q-legacy" role="alert"><b>旧格式</b>{item.message.replace("[旧格式]", "").trim()}。照正本官方格式重写另存新版本（卡片「复制给 AI 修改」里有写法和范本）。</div>)}
    <span>
      <b>正本 h3q</b>{h3q.version ? ` · 正本 ${h3q.version}` : ""} · {h3q.state === "running" && !counts ? "正在检查…" : h3q.state === "fail" ? <>没跑成：{h3q.error}。下面只有画布自己的检查，<b>不能当作通过</b>。</> : counts ? <>ERROR {counts.ERROR} · WARN {counts.WARN} · HINT {counts.HINT}{h3q.state === "running" ? "（正在重查…）" : ""} · {h3q.table ? `已核对对照表 ${h3q.tableFile}` : "未核对对照表（--skip-table）"}</> : null}
    </span>
    <button type="button" className="sc-btn" onClick={rerun}>重新检查</button>
    <button type="button" className="sc-btn" onClick={() => setOpen((value) => !value)}>{open ? "收起" : `对照表${general.length ? ` / 整集 ${general.length} 条` : ""}`}</button>
    {open && <div className="sc-h3q-more">
      <label>对照表路径（队列旁的「…_对照表.md」，不填就跳过对照表）<input className="sc-input mono" value={draft} placeholder="例如 C:\…\EP02_v5_对照表.md" spellCheck={false} onChange={(event) => setDraft(event.target.value)} /></label>
      <button type="button" className="sc-btn" onClick={() => setTableFile(draft.trim())}>用这个对照表</button>
      {h3q.command && <small>运行的是：{h3q.command}</small>}
      {general.length > 0 && <ul>{general.map((item, i) => <li key={i} className={item.level === "ERROR" ? "e" : item.level === "WARN" ? "w" : "h"}>{item.level} {item.where ? `${item.where}：` : ""}{item.message}</li>)}</ul>}
    </div>}
  </div>;
}
type H3qState = { state: "running" | "ok" | "fail"; report?: H3qReport; error?: string; version?: string; table?: boolean; tableFile?: string; command?: string };

/** 没绑参考图（按文生视频出片）：参考图那一格写「画面靠文字定」的几句，灰色，不是错误。超过 6 行折叠，点开看全文。 */
export function T2vBlock({ rows, open = true, toggle, full = false }: { rows: T2vRow[]; open?: boolean; toggle?: () => void; full?: boolean }) {
  const long = rows.reduce((sum, row) => sum + Math.max(1, row.lines.join("").length / 22), 0) > 6;
  const clipped = long && !open && !full;
  return <div className={`sc-t2v ${clipped ? "clip" : ""}`} title={T2V_TITLE}>
    <b className="sc-t2v-head">文生视频 · 画面描述</b>
    <ul>{rows.map((row) => <li key={row.label}><i>{row.label}</i>{row.lines.length ? <span>{row.lines.join(" ")}</span> : <span className="none">没写（文生视频更需要写清楚）</span>}</li>)}</ul>
    {long && !full && toggle && <button type="button" className="sc-t2v-more" onClick={toggle}>{open ? "收起" : "展开全文"}</button>}
    <small className="sc-t2v-note">没绑参考图 · 按文生视频出片（{T2V_NOTE}）</small>
  </div>;
}

function ShotRow({ card, status, video, render, onMove, ignored, onIgnore, delay, ctx, completeness, showKf = true }: { showKf?: boolean; card: CardModel; status?: string; video: ShotVideos | null; render?: RenderInfo; onMove: (text: string, kind: ClauseKind) => void; ignored: ReadonlySet<string>; onIgnore: (code: string, ignore: boolean) => void; delay: number; ctx: EditCtx; completeness?: CategoryResult[] }) {
  const [showPrompt, setShowPrompt] = useState(false);
  const [t2vOpen, setT2vOpen] = useState(false);
  const [editing, setEditing] = useState(ctx.startEditing);
  const [fixError, setFixError] = useState("");
  const [rendering, setRendering] = useState(false);
  const [submittedOnce, setSubmittedOnce] = useState(false);
  // 台词: each role's lines live in the prompt's 对白 row (正本「第一集写法」), so undo / export / 另存 carry them.
  const [linesFor, setLinesFor] = useState<string | null>(null);
  const [linesDraft, setLinesDraft] = useState("");
  const nameOfRole = (roleId: string) => card.roles.find((role) => role.roleId === roleId)?.name ?? roleId;
  const openLines = (roleId: string) => { setFixError(""); if (linesFor === roleId) { setLinesFor(null); return; } setLinesFor(roleId); setLinesDraft(roleLines(card.shot, nameOfRole(roleId)).join("\n")); };
  const saveLines = async (roleId: string) => {
    setFixError("");
    const lines = linesFromText(linesDraft);
    const written = setRoleLines(card.shot, nameOfRole(roleId), lines);
    if ("error" in written) { setFixError(written.error); return; }
    let next = written.shot;
    if (lines.length && card.shot.soundMode !== "av") {
      if (!await askConfirm({ title: "改成有声？", message: `台词要「有声」才说得出来。这一镜现在是「${SOUND_LABEL[card.shot.soundMode] ?? card.shot.soundMode}」，保存台词时改成「有声 av」吗？背景乐禁用不变。`, confirmLabel: "改成有声并保存", cancelLabel: "先不保存" })) { setFixError("没保存：台词要「有声」才说得出来"); return; }
      next = { ...next, soundMode: "av" };
    }
    const lock = ctx.lockNow(); if (lock) { setFixError(lock); return; }
    const problem = ctx.save(next);
    if (problem) setFixError(problem); else setLinesFor(null);
  };
  const quickFix = (code: string) => {
    setFixError("");
    if (code === "dialogue_field") { const result = dialogueFieldToRow(card.shot, nameOfRole); const problem = "error" in result ? result.error : ctx.save(result.shot); if (problem) setFixError(problem); }
    if (code === "music_named") { const problem = ctx.save({ ...card.shot, prompt: removeMusicSentences(card.shot.prompt) }); if (problem) setFixError(problem); }
  };
  const FIXABLE: Record<string, string> = { dialogue_field: "把台词搬进正文对白", music_named: "一键删掉这句" };
  const { shot, breakdown: b } = card;
  const live = card.checks.filter((check) => !ignored.has(check.code));
  const errors = live.filter((check) => check.level === "error"), warns = live.filter((check) => check.level === "warn"), hints = live.filter((check) => check.level === "hint");
  const hidden = card.checks.filter((check) => ignored.has(check.code));
  const state = errors.length ? "bad" : warns.length ? "warn" : "ok";
  const title = splitTitle(shot.title, card.index);

  // "最终" is shown once, before the first ending clause of a segment.
  const clauses = (items: string[], kind: ClauseKind, sep = "，") => items.map((text, i) => {
    const ending = text.startsWith("最终：");
    const firstEnding = ending && !items[i - 1]?.startsWith("最终：");
    return <span key={i}>{i ? (firstEnding ? "。" : sep) : ""}<Clause text={ending ? text.slice(3) : text} kind={kind} onMove={onMove} names={card.names} prefix={firstEnding ? "最终" : ""} /></span>;
  });
  // "张三开口 / Subject 1 speaks" → that role's lines appear inside the segment.
  const spoken = new Set<string>();
  const beatLines = (story: string[]) => story.flatMap((clause) => {
    const who = /^(.+?) speaks\b/.exec(nameSubjects(clause, card.names))?.[1] ?? /^(.+?)(?:开口|说话|说)/.exec(clause)?.[1];
    const lines = who ? card.linesByName[who] ?? [] : [];
    if (!who || spoken.has(who) || !lines.length) return [];
    spoken.add(who);
    return lines.map((text) => ({ who, text }));
  });
  const rendered = b.beats.filter((beat) => beat.story.length).map((beat) => ({ beat, lines: beatLines(beat.story) }));
  const unplacedDialogue = spoken.size ? [] : card.dialogue;
  const timedBeats = b.beats.filter((beat) => beat.start >= 0);
  const beatCamera = timedBeats.filter((beat) => beat.camera.length);
  const looks = [...b.look, ...b.beats.flatMap((beat) => beat.look)];
  const sounds = [...b.sound, ...b.beats.flatMap((beat) => beat.sound)];
  const lips = [...b.lip, ...b.beats.flatMap((beat) => beat.lip)];
  const cell = (label: string, value: ReactNode, tone = "", wide = false, key = label) => <div key={key} className={`sc-cell ${tone} ${wide ? "wide" : ""}`}><span>{label}</span><b>{value}</b></div>;
  // 速度优先 = default (10 steps, accelerated); 理解优先 = understanding (25 steps, slower, timing more accurate). Ultimate only, not for 延长.
  const canUnderstand = card.option.workflow === "ultimate" && card.option.generationMode !== "extend";
  const setTuning = (tuning: "default" | "understanding") => { setFixError(""); const problem = ctx.save({ ...shot, tuning }); if (problem) setFixError(problem); };
  // 秒数 ▲▼ / 「改成 N 秒」/ 像素快选：和别的卡片修改一样走 ctx.save（进撤销历史；入队过、提交中 ctx.locked 拦住）。
  const quickSave = (next: ShotQueueShot) => { setFixError(""); if (ctx.locked) { setFixError(ctx.locked); return; } const problem = ctx.save(next); if (problem) setFixError(problem); };
  const setSeconds = (seconds: number) => { if (seconds !== shot.seconds) quickSave({ ...shot, seconds }); };
  const pickMp = (value: MpPreset) => quickSave(withMegapixels(shot, value));
  const quickLock = ctx.locked ? (ctx.locked.includes("入队过") ? "已入队过，要改先另存成新队列" : ctx.locked) : "";
  const currentMp = mpPreset(card.megapixels);
  const advice = card.durationAdvice;
  // 程序体检：h3q 还没跑完时先显示全部（去重要等 h3q 结果）
  const healthItems = card.health?.items ?? card.healthRaw;
  const healthMerged = card.health?.merged ?? [];

  if (editing) return <article className={`sc-row editing ${state}`} id={`shot-card-${card.key}`} data-title={shot.title}>
    <div className="sc-slate"><div className="sc-code">{title.code}</div><div className="sc-name">{title.name}</div><span className="sc-chip amber">编辑中</span></div>
    <ShotEditor card={card} ctx={ctx} onDone={() => setEditing(false)} />
  </article>;

  return <article className={`sc-row ${state}${ctx.gate?.confirmation ? " gate-confirmed" : ""}`} title={ctx.gate?.confirmation ? `画面五项已人工放行：${ctx.gate.confirmation.reason}` : undefined} id={`shot-card-${card.key}`} data-title={shot.title} style={{ animationDelay: `${Math.min(delay, 14) * 35}ms` }}>
    {/* 镜头 */}
    <div className="sc-slate">
      <div className="sc-code">{title.code}</div>
      <div className="sc-name">{title.name}</div>
      <span className={`sc-chip ${status ? "cold" : "idle"}`} title={status ? undefined : "还没入队：点顶栏「全部入队」或章节旁「本章入队」才开始渲染"}>{status ?? "未入队"}</span>
      <span className={`sc-chip ${state === "bad" ? "stop" : state === "warn" ? "amber" : "go"}`}>{errors.length ? `写错 ${errors.length}` : warns.length ? `漏写 ${warns.length}` : "检查通过"}</span>
      {card.official && <span className="sc-chip idle" title={`官方 Ref2VA 六段式：正文原样提交，不加禁背景乐句、不加台词 / 声音追加段；${shot.voiceRoleIds?.length ? `送 ${shot.voiceRoleIds.length} 条角色声音（voiceRoleIds 顺序 = <Audio 1>…，各截前 8 秒）` : "没写 voiceRoleIds，不送角色声音"}。${OFFICIAL_MUSIC_NOTE}${card.noBgm ? "（队列勾了禁背景乐，也不往正文加句子）" : ""}；写法对错看正本 h3q 的 [官方·…]`}>官方格式</span>}
      <button type="button" className="sc-btn sc-render-btn" disabled={Boolean(ctx.canRender) || rendering} title={ctx.canRender || "只渲染这一镜：在画布上建（或找到）这一镜的节点并点生成"} onClick={() => { setRendering(true); setFixError(""); void ctx.render().then((problem) => { setRendering(false); setFixError(problem ?? ""); if (!problem) setSubmittedOnce(true); }); }}>{rendering ? "提交中…" : submittedOnce ? "已提交，再渲一次" : "渲染这一镜"}</button>
      <button type="button" className="sc-btn sc-edit-btn" onClick={() => setEditing(true)} disabled={Boolean(ctx.locked)} title={ctx.locked || "改参考图、角色、参数、提示词、台词"}>编辑这一镜</button>
      {!showKf && <button type="button" className="sc-btn sc-kf-small" disabled={Boolean(ctx.locked)} title={ctx.locked || "给这一镜写关键帧描述，先出图挑首帧，再出视频（用了以后右边会多出「关键帧」一列）"} onClick={() => setEditing(true)}>＋ 先出关键帧</button>}
      <div className="sc-row-tools">
        {ctx.locate && <button type="button" aria-label="定位到画布节点" title="在画布上定位并选中这个镜头节点" onClick={ctx.locate}><Crosshair aria-hidden="true" /></button>}
        <button type="button" aria-label="复制这一镜" title={ctx.structureLocked || "在下面复制出一镜，直接进入编辑"} disabled={Boolean(ctx.structureLocked)} onClick={() => { const problem = ctx.duplicate(); if (problem) setFixError(problem); }}><Copy aria-hidden="true" /></button>
        {ctx.copyForAi && <button type="button" className="sca-one" aria-label="复制这一镜的问题给 AI" title="把这一镜的问题（漏写、正本 h3q、画布检查、画面五项）复制成一段中文，贴给 AI 改" onClick={ctx.copyForAi}><ClipboardCopy aria-hidden="true" /></button>}
        <button type="button" aria-label="对比实验" title={ctx.experiment ? "对比实验：复制成 A / B 两条，只改一段、同一个种子，一起入队比较哪种写法好" : "队列正在提交，先在「JSON / 进度」里点「停止后续排队」"} disabled={!ctx.experiment} onClick={ctx.experiment}><Columns2 aria-hidden="true" /></button>
        <button type="button" aria-label="往上挪一镜" title={ctx.structureLocked || "往上挪一镜"} disabled={Boolean(ctx.structureLocked)} onClick={() => { const problem = ctx.shift(-1); if (problem) setFixError(problem); }}><ArrowUp aria-hidden="true" /></button>
        <button type="button" aria-label="往下挪一镜" title={ctx.structureLocked || "往下挪一镜"} disabled={Boolean(ctx.structureLocked)} onClick={() => { const problem = ctx.shift(1); if (problem) setFixError(problem); }}><ArrowDown aria-hidden="true" /></button>
        <button type="button" aria-label="接尾帧" title={ctx.structureLocked || "在下面加一镜，首帧接这一镜的尾帧；设置照抄，你改剧情"} disabled={Boolean(ctx.structureLocked)} onClick={() => void ctx.chainFromTail().then((problem) => { if (problem) setFixError(problem); })}><Link2 aria-hidden="true" /></button>
        <button type="button" aria-label="删掉这一镜" className="del" title={ctx.structureLocked || "从队列删掉这一镜"} disabled={Boolean(ctx.structureLocked)} onClick={() => void askConfirm({ message: `从队列删掉「${shot.title}」？只改队列 JSON，画布上已有的节点和视频不动。`, confirmLabel: "删掉这一镜", danger: true }).then((ok) => { if (!ok) return; const problem = ctx.remove(); if (problem) setFixError(problem); })}><Trash2 aria-hidden="true" /></button>
      </div>
      <button type="button" className="sc-toggle" onClick={() => setShowPrompt((value) => !value)}>{showPrompt ? <ChevronDown size={13} /> : <ChevronRight size={13} />}原文 {shot.prompt.length} 字</button>
    </div>

    {/* 参考图 */}
    {/* 参考图分两组各占一行：「场景」（场景图、首帧、尾帧）和「角色」；P 编号仍是提交顺序 */}
    <div className="sc-refs">
      {card.pictures.length ? REF_GROUPS.map((group) => { const items = card.pictures.filter((picture) => refGroupOf(picture.name) === group.id);
        return <div className="sc-ref-group" key={group.id} data-group={group.id}><span className="sc-ref-head">{group.label}</span>
          <div className="sc-ref-items">{items.length ? items.map((picture) => <Thumb key={picture.label} ids={refIds(picture)} src={picture.src} tag={picture.label.replace("Picture ", "P")} label={`${picture.name.replace(/^(角色|场景|首帧|尾帧) /, "")}${picture.subjects ? ` · ${picture.subjects}` : ""}`} onOpen={ctx.zoomRef && (() => ctx.zoomRef!(picture.label.replace("Picture ", "P")))} />) : <em className="sc-ref-none">无</em>}</div>
        </div>; })
        : (() => { const cellText = card.refError || card.refProblems.length ? referenceCellText(card.refProblems, card.refError) : null;
          return cellText ? <div className="sc-ref-missing sc-ref-why" title={card.refError ? `原文：${card.refError}` : undefined}>{cellText.text}{cellText.more > 0 ? `（还有 ${cellText.more} 项）` : ""}{cellText.owner && <em>——{cellText.owner}</em>}</div> : <T2vBlock rows={t2vDescription(shot, completeness)} open={t2vOpen} toggle={() => setT2vOpen((value) => !value)} />; })()}
    </div>

    {/* 关键帧 */}
    {showKf && <KeyframeCell card={card} ctx={ctx} onEdit={() => setEditing(true)} />}

    {/* 参数格子 */}
    <div className="sc-cells">
      {cell("秒数", <span className="sc-sec">{card.requested}<small>s</small><span className="sc-sec-step">
        <button type="button" aria-label="加 1 秒" title={quickLock || (canStepSeconds(shot.seconds, 1) ? "加 1 秒" : "最多 15 秒（正本 h3q：seconds 5～15）")} disabled={Boolean(ctx.locked) || !canStepSeconds(shot.seconds, 1)} onClick={() => setSeconds(stepSeconds(shot.seconds, 1))}>▲</button>
        <button type="button" aria-label="减 1 秒" title={quickLock || (canStepSeconds(shot.seconds, -1) ? "减 1 秒" : "最少 5 秒（正本 h3q：seconds 5～15）")} disabled={Boolean(ctx.locked) || !canStepSeconds(shot.seconds, -1)} onClick={() => setSeconds(stepSeconds(shot.seconds, -1))}>▼</button>
      </span></span>, advice?.kind ? "amber" : "")}
      {cell("实际", <>{card.actual.toFixed(2)}<small>s · {card.frames}帧</small></>, card.overflow ? "stop" : "")}
      {cell("预计", <span title={`${ctx.estimate.note}（估算，不含排队和后处理）`}>{shortEstimate(ctx.estimate)}<small>估算</small></span>)}
      {cell("像素", <span className="sc-mp" role="radiogroup" aria-label="像素预算">{MP_PRESETS.map((value) => <button key={value} type="button" role="radio" aria-checked={currentMp === value} className={currentMp === value ? "on" : ""} disabled={Boolean(ctx.locked)} title={quickLock || (value === 0.45 ? "0.45 MP：测试 / 小样一律用这个" : "0.88 MP：正式出片")} onClick={() => currentMp !== value && pickMp(value)}>{value.toFixed(2)}{value === 0.45 && <small>测试</small>}</button>)}{currentMp === null && <em title="队列里写的像素；点 0.45 或 0.88 改成那个值">现在 {card.megapixels.toFixed(2)}</em>}</span>)}
      {advice && <div className={`sc-cell wide sc-duration ${advice.kind ? "amber" : ""}`}><span>时长 · 正本 h3q{advice.kind === "long" ? " · 偏长" : advice.kind === "short" ? " · 偏短" : ""} · 只提醒，不拦截入队</span>
        <b>{advice.text.replace(/^\[时长\]\s*/, "")}</b>
        {advice.suggest !== null && <div className="sc-duration-actions">
          <button type="button" className="sc-btn" disabled={Boolean(ctx.locked) || advice.suggest === shot.seconds} title={quickLock || (advice.suggest === shot.seconds ? "已经是这个秒数，等 h3q 重新检查" : `秒数 ${shot.seconds} → ${advice.suggest}，进撤销历史`)} onClick={() => setSeconds(advice.suggest!)}>{advice.suggest === shot.seconds ? `已改成 ${advice.suggest} 秒` : `改成 ${advice.suggest} 秒`}</button>
          {advice.keep && <small className="muted">或者{advice.keep}（改正文，你自己决定）</small>}
        </div>}
      </div>}
      {card.chainHint && !shot.firstFrameFrom && <div className="sc-cell wide sc-duration sc-chain-hint"><span>接尾帧 · 正本 h3q · 只提示，接不接你定</span>
        <b>可以接上一镜「{card.chainHint.from}」的尾帧{card.chainHint.why ? `：${card.chainHint.why}` : ""}</b>
        <div className="sc-duration-actions">
          <button type="button" className="sc-btn" disabled={Boolean(ctx.locked)} title={quickLock || "这一镜改成首帧接上一镜尾帧（generationMode first-last + firstFrameFrom），提示词不动；进撤销历史。代价：上一镜的瑕疵会带进来，入队时要等上一镜出完再排"} onClick={() => { setFixError(""); const problem = ctx.chainUp(); if (problem) setFixError(problem); }}>一键接上</button>
          <small className="muted">不接就不用管，不拦截入队</small>
        </div>
      </div>}
      {cell("尺寸", card.size ? <>{card.size.width}<small>×</small>{card.size.height}</> : shot.aspect)}
      {card.official ? cell("镜头", `${officialCuts(shot.prompt).length || 1} 个 [Shot]，机位写在正文里`, "", true) : cell("镜头", b.camera.length ? clauses(b.camera.slice(0, 4), "camera", " · ") : beatCamera.length ? `${beatCamera.length} 段单独写了` : "未写", b.camera.length || beatCamera.length ? "" : "amber", true)}
      {cell("声音", SOUND_LABEL[shot.soundMode] ?? shot.soundMode)}
      {card.official ? (() => { const music = officialSections(shot.prompt).non_diegetic_music ?? ""; const none = /^N\/?A\.?$/i.test(music.trim()); return cell("背景乐", <span title={`${OFFICIAL_MUSIC_NOTE}：${music || "（没写）"}`}>{none ? "N/A（不要）" : music ? "正文写了配乐" : "没写"}</span>, none ? "go" : "amber"); })() : cell("背景乐", card.noBgm ? "已禁" : "未禁", card.noBgm ? "go" : "amber")}
      {card.roles.map((role) => cell(role.offscreen ? "画外音" : "角色", <span className="sc-role">{role.missing ? <em className="stop">库里没有</em> : <>{role.name}<i className={role.offscreen ? "" : role.appearance ? "go" : "stop"} title="主外观">外观</i><i className={role.voice ? "go" : role.speaks && shot.soundMode === "av" ? "stop" : ""} title="主声音">声音</i><button type="button" className={`lines ${roleLines(shot, role.name).length ? "on" : ""}`} aria-expanded={linesFor === role.roleId} disabled={Boolean(ctx.locked) || card.official} title={ctx.locked || (card.official ? OFFICIAL_LINES_EDIT : "这个角色在这一镜说的话：写进正文「对白」那一行；不填就什么都不加")} onClick={() => openLines(role.roleId)}>台词{roleLines(shot, role.name).length ? ` ${roleLines(shot, role.name).length}` : ""}</button></>}</span>, role.missing ? "stop" : "", true, role.roleId))}
      {linesFor && (() => { const role = card.roles.find((item) => item.roleId === linesFor); if (!role) return null; const inField = (shot.dialogue ?? []).filter((line) => line.roleId === role.roleId).map((line) => line.text); return <div className="sc-cell wide sc-lines-edit"><span>{role.name} 的台词 · 一行一句 · 写进正文「对白（中文普通话，口型同步）：」那一行，原样提交；清空就从对白行去掉</span>
        <textarea className="sc-input" rows={Math.max(2, linesDraft.split("\n").length)} value={linesDraft} spellCheck={false} onChange={(event) => setLinesDraft(event.target.value)} />
        {inField.length > 0 && <small className="dim">旧的 dialogue 字段里还有 {role.name} {inField.length} 句：{inField.join(" / ")}。正本要求 dialogue 留空。<button type="button" className="sc-btn" onClick={() => { setLinesFor(null); quickFix("dialogue_field"); }}>把台词搬进正文对白</button></small>}
        <div className="sc-lines-actions"><button type="button" className="sc-btn primary" disabled={Boolean(ctx.locked)} onClick={() => void saveLines(role.roleId)}>保存台词</button><button type="button" className="sc-btn" onClick={() => setLinesFor(null)}>取消</button></div>
      </div>; })()}
      <div className="sc-cell wide sc-tuning"><span>渲染方式 · {WORKFLOW_LABEL[card.option.workflow] ?? card.option.workflow}{card.option.generationMode !== "auto" ? ` · ${MODE_LABEL[card.option.generationMode]}` : ""}</span>
        <div className="sc-seg-switch" role="radiogroup" aria-label="渲染方式">
          <button type="button" role="radio" aria-checked={card.option.tuning !== "understanding"} className={card.option.tuning !== "understanding" ? "on" : ""} disabled={Boolean(ctx.locked)} title="10 步加速，快" onClick={() => card.option.tuning === "understanding" && setTuning("default")}>速度优先</button>
          <button type="button" role="radio" aria-checked={card.option.tuning === "understanding"} className={card.option.tuning === "understanding" ? "on u" : ""} disabled={Boolean(ctx.locked) || !canUnderstand} title={canUnderstand ? "去加速、25 步，动作时间点更准，慢约 1.5–2.3 倍；打斗、动作多的镜头用" : "理解优先只用于终极版，不用于延长"} onClick={() => card.option.tuning !== "understanding" && setTuning("understanding")}>理解优先</button>
        </div>
      </div>
      {card.relation && cell("接帧", card.relation, "cold", true)}
    </div>

    {fixError && !(errors.length || warns.length || hidden.length) && <p className="sc-intake-error" style={{ gridColumn: "2/-1" }}>{fixError}</p>}
    {/* 剧情 */}
    <div className="sc-story">
      {card.official && <p className="sc-lede" lang="en">{officialSections(shot.prompt).summary ?? ""}</p>}
      {!card.official && b.summary.length > 0 && <p className="sc-lede">{clauses(b.summary, "story")}</p>}
      {!card.official && rendered.length > 0 && <ol className="sc-beats">{rendered.map(({ beat, lines }) => <li key={beat.range} className={beat.range === "开始" ? "start" : ""}>
        <time>{beat.range}</time>
        <div>{clauses(beat.story, "story")}{beat.camera.length > 0 && <small className="sc-beat-cam">{clauses(beat.camera, "camera", " · ")}</small>}{lines.map((line, i) => <q key={i}><em>{line.who}</em>{line.text}</q>)}</div>
      </li>)}</ol>}
      {unplacedDialogue.length > 0 && <div className="sc-dialogue">{unplacedDialogue.map((line, i) => <q key={i}>{line}</q>)}</div>}
      {!card.official && !b.summary.length && !rendered.length && <p className="muted">{b.unstructured ? "提示词没有「主要动作」「几秒到几秒」这类标签，展开原文看" : "没写剧情"}</p>}
      {!card.official && (looks.length > 0 || sounds.length > 0 || lips.length > 0) && <details className="sc-more"><summary>画面 {looks.length} · 声音 {sounds.length} · 口型 {lips.length}</summary>
        {looks.length > 0 && <p><em>画面</em>{clauses(looks, "look")}</p>}
        {sounds.length > 0 && <p><em>声音</em>{clauses(sounds, "sound", " · ")}</p>}
        {lips.length > 0 && <p className="dim"><em>口型</em>{clauses(lips, "lip")}</p>}
      </details>}
    </div>

    {/* 视频 */}
    <VideoTile videos={video} render={render} aspect={shot.aspect} onZoom={ctx.zoom} demix={video?.chosen ? ctx.demix?.(video) : undefined} extra={video?.chosen && ctx.review?.(video)} onChoose={(version) => { void ctx.choose(version).then((problem) => setFixError(problem ?? "")); }} />

    {/* 提示词完整度：只标出来，不拦截入队 */}
    {completeness && <CompletenessRow results={completeness} gate={ctx.gate} verdict={card.gate} fromEpisode={episodeCategories(shot, ctx.episode)} extra={(category) => !category.preset ? null : card.official ? <p className="pp-official muted">{OFFICIAL_PRESET_NOTE}</p> : <PresetPicker category={category} ctx={ctx.preset} />} />}

    {/* 检查 */}
    {(errors.length > 0 || warns.length > 0 || hints.length > 0 || hidden.length > 0 || healthItems.length > 0) && <div className={`sc-checks ${state}`}>
      {ctx.copyForAi && <button type="button" className="sc-btn sc-checks-copy" title="把这一镜的问题（画布红字、正本 h3q、程序体检、ID 怎么改、漏写、画面五项）复制成一段中文，贴给写队列的 AI 改" onClick={ctx.copyForAi}><ClipboardCopy aria-hidden="true" />复制给 AI 修改</button>}
      <ul>
        {errors.map((check, i) => <li key={"e" + i} className="e"><CheckSource check={check} />{check.message}{FIXABLE[check.code] && !ctx.locked && <button type="button" className="fix" onClick={() => quickFix(check.code)}>{FIXABLE[check.code]}</button>}</li>)}
        {warns.map((check, i) => <li key={"w" + i} className="w"><CheckSource check={check} />{check.message}<button type="button" title="这一镜不再提示这一条（只记在这台电脑）" onClick={() => onIgnore(check.code, true)}>这镜不用</button></li>)}
        {hints.map((check, i) => <li key={"h" + i} className="h"><CheckSource check={check} />建议：{check.message}</li>)}
      </ul>
      {fixError && <p className="sc-intake-error">{fixError}</p>}
      {hidden.length > 0 && <p className="sc-ignored">已忽略 {hidden.length} 条 <button type="button" onClick={() => [...new Set(hidden.map((check) => check.code))].forEach((code) => onIgnore(code, false))}>全部恢复</button></p>}
      {healthItems.length > 0 && <details className="sc-more"><summary>程序体检 {healthItems.length}</summary><ul className="sc-health">{healthItems.map((entry, i) => <li key={i}>{entry.message}</li>)}</ul>
        {healthMerged.length > 0 && <p className="sc-health-merged">另有 {healthMerged.length} 条和别处重复，已合并：{healthMerged.map((entry) => `「${entry.message.replace(/^体检：/, "").slice(0, 18)}…」见${entry.into}`).join("；")}</p>}</details>}
    </div>}

    {showPrompt && <EpisodePrompt shot={shot} episode={ctx.episode} />}
  </article>;
}
/** JSON in: paste or pick a file. onLoad parses and hands the queue to the 队列 panel; it returns an error message or null. */
function QueueInput({ hasQueue, onLoad, onCancel, onClose, incoming }: { hasQueue: boolean; onLoad: (text: string) => string | null | Promise<string | null>; onCancel: () => void; onClose: () => void; incoming?: CardIncoming }) {
  const [text, setText] = useState("");
  const [error, setError] = useState("");
  const [dragging, setDragging] = useState(false);
  const submit = (value = text) => { if (!value.trim()) { setError("先粘贴或载入队列 JSON"); return; } void Promise.resolve(onLoad(value)).then((problem) => setError(problem ?? "")); };
  const readFile = (file?: File | null) => { if (!file) return; if (file.size > 1_500_000) { setError("文件太大，不像镜头表"); return; } void file.text().then((value) => { setText(value); submit(value); }).catch(() => setError("文件读取失败")); };
  // 载入路径 JSON 队列：开发服务器只读那个文件，拿回原文后和「载入 JSON 文件」一样填进文本框、照常检查。不入队。
  const [pathValue, setPathValue] = useState("");
  const [pathBusy, setPathBusy] = useState(false);
  const [recent, setRecent] = useState<string[]>(() => loadRecentQueuePaths());
  const [recentOpen, setRecentOpen] = useState(false);
  const loadPath = async (value = pathValue) => {
    if (pathBusy) return;
    if (!value.trim()) { setError("先粘贴一个 JSON 文件路径"); return; }
    setPathBusy(true); setRecentOpen(false); setError("");
    const result = await readQueuePath(value);
    if (!result.ok) { setPathBusy(false); setError(result.error); return; }
    setPathValue(result.path); setRecent(rememberQueuePath(result.path));
    if (result.size > 1_500_000) { setPathBusy(false); setError("文件太大，不像镜头表"); return; }
    setText(result.text);
    const undoTable = rememberTableForQueue(result.text, result.tableFile);
    const problem = await Promise.resolve(onLoad(result.text)).catch(() => "载入失败");
    setPathBusy(false);
    if (problem) { undoTable(); setError(problem); }
  };
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape" && !event.isComposing && !isTypingTarget(event.target)) { event.stopPropagation(); (hasQueue ? onCancel : onClose)(); } };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [hasQueue, onCancel, onClose]);
  return createPortal(<div className="sc-root" role="dialog" aria-modal="true" aria-label="镜头卡片 · 输入队列" onPointerDown={(event) => event.stopPropagation()} onWheel={(event) => event.stopPropagation()}>
    <style>{STYLE}</style>
    <header className="sc-slate-head">
      <div className="sc-title"><span className="sc-kicker">SHOT CARDS · 渲染前检查 · 点「渲染这一镜」「出关键帧」会用显卡</span><h2>放进队列 JSON</h2></div>
      <button type="button" className="sc-close" aria-label="关闭镜头卡片" onClick={onClose}><X size={18} /></button>
    </header>
    {incoming && <div className="sc-bulk kf" role="status"><span>收件箱来了新队列「{incoming.file}」。「JSON / 进度」里原来的文本没有被换掉。</span><button type="button" className="sc-btn" onClick={incoming.switchTo}>切换到新队列</button></div>}
    <div className={`sc-intake ${dragging ? "drag" : ""}`} onDragOver={(event) => { event.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={(event) => { event.preventDefault(); setDragging(false); readFile(event.dataTransfer.files?.[0]); }}>
      <p className="sc-intake-hint">把 <code>shot-queue-v1</code> 队列粘贴到下面，或者拖一个 .json 文件进来，或者在左下角粘贴文件路径按回车。这里只检查，不会提交渲染；载入后同一份队列也会出现在「JSON / 进度」抽屉里。</p>
      <textarea value={text} spellCheck={false} placeholder='{"version":"shot-queue-v1","title":"…","chapters":[…]}' onChange={(event) => { setText(event.target.value); setError(""); }} onKeyDown={(event) => { if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) submit(); }} />
      {error && <p className="sc-intake-error">{error}</p>}
      <div className="sc-intake-actions">
        <div className="sc-path">
          <input className="sc-input" aria-label="载入路径 JSON 队列" value={pathValue} readOnly={pathBusy} aria-busy={pathBusy} spellCheck={false} autoComplete="off"
            placeholder={pathBusy ? "正在读取…" : "粘贴 JSON 文件路径，回车载入"}
            title="粘贴 AI 给的队列文件路径（带不带引号、正斜杠反斜杠都行），按回车或粘贴后自动载入；旁边有同名 _对照表.md 会一起用上"
            onChange={(event) => { setPathValue(event.target.value); setError(""); }}
            onFocus={() => setRecentOpen(true)} onBlur={() => setRecentOpen(false)}
            onPaste={(event) => { const pasted = event.clipboardData.getData("text"); if (!looksLikeJsonPath(pasted)) return; event.preventDefault(); setPathValue(pasted.trim()); void loadPath(pasted); }}
            onKeyDown={(event) => { if (event.nativeEvent.isComposing) return; if (event.key === "Enter") { event.preventDefault(); void loadPath(); } else if (event.key === "ArrowDown") setRecentOpen(true); else if (event.key === "Escape" && recentOpen) { event.stopPropagation(); setRecentOpen(false); } }} />
          {recentOpen && recent.length > 0 && !pathBusy && <ul className="sc-path-recent" role="listbox" aria-label="最近用过的路径">
            <li className="sc-path-recent-head">最近用过（点一下载入）</li>
            {recent.map((item) => <li key={item}><button type="button" title={item} onMouseDown={(event) => event.preventDefault()} onClick={() => { setPathValue(item); void loadPath(item); }}>{item}</button></li>)}
          </ul>}
        </div>
        <label className="sc-btn">载入 JSON 文件<input type="file" accept=".json,application/json" hidden onChange={(event) => { readFile(event.target.files?.[0]); event.target.value = ""; }} /></label>
        {hasQueue && <button type="button" className="sc-btn" onClick={onCancel}>回到当前队列</button>}
        <button type="button" className="sc-btn primary" onClick={() => submit()}>检查并打开卡片 <small>Ctrl+Enter</small></button>
      </div>
    </div>
  </div>, document.body);
}

/** 空状态：还没有队列。队列面板把「JSON / 进度」抽屉直接打开在右边，这里只放说明。Escape 由抽屉处理（关掉卡片）。 */
function EmptyCards({ onClose, incoming }: { onClose: () => void; incoming?: CardIncoming }) {
  const headRef = useHeadHeight();
  return createPortal(<div className="sc-root" role="dialog" aria-modal="true" aria-label="镜头卡片 · 还没有队列" onPointerDown={(event) => event.stopPropagation()} onWheel={(event) => event.stopPropagation()}>
    <style>{STYLE + SC_HEADER_STYLE}</style>
    <header className="sc-slate-head scf-head sc-empty-head" ref={headRef}>
      <div className="scf-line1"><h2>镜头卡片</h2><span className="scf-meta">还没有队列</span>
      <div className="sc-head-actions"><button type="button" className="sc-btn on" aria-expanded="true" disabled>JSON / 进度</button><button type="button" className="sc-close" aria-label="关闭镜头卡片" onClick={onClose}><X size={18} /></button></div></div>
    </header>
    {incoming && <div className="sc-bulk kf" role="status"><span>收件箱来了新队列「{incoming.file}」。「JSON / 进度」里原来的文本没有被换掉。</span><button type="button" className="sc-btn" onClick={incoming.switchTo}>切换到新队列</button></div>}
    <div className="sc-empty-guide">
      <p><b>先放进一份队列 JSON。</b></p>
      <p>在右边「JSON / 进度」里粘贴 <code>shot-queue-v1</code> 队列，或点「载入 JSON 文件」，再点「检查镜头表」。检查通过后，这里每一镜一张卡片。</p>
      <p className="muted">检查不会提交渲染。要渲染，在「JSON / 进度」里点「全部镜头入队／继续未完成」，会先在页面里问你一次。</p>
    </div>
  </div>, document.body);
}

/** 换队列会覆盖「JSON / 进度」抽屉里的文本：先确认。 */
const replacingConfirmed = (queue: ShotQueue) => askConfirm({ message: `换成新队列后，「JSON / 进度」里「${queue.title}」的文本会被替换（已建的画布节点和视频不动）。继续？`, confirmLabel: "换成新队列" });

/** 修改历史（撤销 / 恢复）、导出 JSON、收件箱新队列提示条、「JSON / 进度」抽屉：都由 components/shot-queue-panel.tsx 提供，卡片只负责显示按钮。 */
export interface CardHistory { label: string; canUndo: boolean; canRedo: boolean; undo: () => void; redo: () => void }
export interface CardIncoming { file: string; count: number; hidden: boolean; switchTo: () => void; later: () => void }
/** 卡片顶栏「JSON / 进度」：原来「队列」面板的全部功能（JSON、入队、进度、停止、开关）。抽屉本身由队列面板渲染在卡片上面。 */
export interface CardEnqueue {
  /** 「全部入队（N 镜）」/「继续未完成（N 镜）」/「排队中 3/26」 */
  label: string; title: string; disabled: boolean; running: boolean;
  /** 和「JSON / 进度」里的按钮同一个 startManual：打开抽屉 + 入队（入队前在页面里确认、画面五项照常拦） */
  all: () => void; chapter: (index: number) => void; chapterBusy: boolean;
  stop?: () => void;
  /** 正在停（按钮变「正在停止…」） */
  stopping?: boolean;
  /** 提交循环几秒内没退出时才有：强制解锁（会先在页面里问，写明后果） */
  forceUnlock?: () => void;
}
export interface CardQueueDrawer { open: boolean; toggle: () => void; busy: boolean; onReplacing?: (replacing: boolean) => void; enqueue?: CardEnqueue }

/** 顶栏高度写进 --sc-head-h，「JSON / 进度」抽屉贴着它的下沿（顶栏两行，高度随宽度变）。 */
function useHeadHeight() {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    const el = ref.current; if (!el) return;
    const set = () => document.documentElement.style.setProperty("--sc-head-h", `${Math.round(el.getBoundingClientRect().height)}px`);
    set(); const observer = new ResizeObserver(set); observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return ref;
}
type CardExtras = { history?: CardHistory; exportJson?: () => void; incoming?: CardIncoming; queueDrawer?: CardQueueDrawer; nodeIds?: Record<string, string> };
export function ShotCardBoard({ queue, statuses, onClose, onLoad, onChange, locked = "", canvas, history, exportJson, incoming, queueDrawer, nodeIds }: { queue: ShotQueue | null; statuses: Record<string, string | undefined>; onClose: () => void; onLoad: (text: string) => string | null; onChange: (next: ShotQueue) => string | null; locked?: string; canvas?: CardCanvas } & CardExtras) {
  const lockedNow = useRef(locked); lockedNow.current = locked;
  const [replacing, setReplacing] = useState(false);
  const cancel = useCallback(() => setReplacing(false), []);
  const onReplacing = queueDrawer?.onReplacing;
  useEffect(() => { onReplacing?.(Boolean(queue) && replacing); }, [onReplacing, queue, replacing]);
  // 没有队列：空卡片 + 「JSON / 进度」抽屉（在抽屉里粘贴 / 载入 / 填示例 / 检查）。
  if (!queue && queueDrawer) return <EmptyCards onClose={onClose} incoming={incoming} />;
  if (!queue || replacing) return <QueueInput hasQueue={Boolean(queue)} incoming={incoming} onCancel={cancel} onClose={onClose} onLoad={async (text) => { if (locked) return locked; if (queue && !await replacingConfirmed(queue)) return "已取消，当前队列没有被换掉"; if (lockedNow.current) return lockedNow.current; const problem = onLoad(text); if (!problem) setReplacing(false); return problem; }} />;
  return <ShotCardView key={queue.title} queue={queue} statuses={statuses} onClose={onClose} onReplace={() => setReplacing(true)} onChange={onChange} onLoad={onLoad} locked={locked} canvas={canvas} history={history} exportJson={exportJson} incoming={incoming} queueDrawer={queueDrawer} nodeIds={nodeIds} />;
}

function ShotCardView({ queue, statuses, onClose, onReplace, onChange: applyChange, onLoad, locked: busyLock, canvas, history, exportJson, incoming, queueDrawer, nodeIds }: { queue: ShotQueue; statuses: Record<string, string | undefined>; onClose: () => void; onReplace: () => void; onChange: (next: ShotQueue) => string | null; onLoad: (text: string) => string | null; locked: string; canvas?: CardCanvas } & CardExtras) {
  // A queue with submitted entries must not be edited in place: 全部入队 would see a different queue and re-render every shot.
  const submitted = Object.values(statuses).some(Boolean);
  const locked = busyLock || (submitted ? "这份队列已经入队过，在这里改了再点入队会整批重新渲染；要改就点上面「另存成新队列」" : "");
  const headRef = useHeadHeight();
  // 撤销 / 恢复：顶栏按钮和 Ctrl+Z / Ctrl+Y 走同一处；撤完在顶栏轻提示「已撤销：L03 正文」，约 2 秒消失。
  const [undoNote, setUndoNote] = useState("");
  const undoTimer = useRef(0);
  const pendingUndo = useRef<{ intent: UndoIntent; before: ShotQueue } | null>(null);
  const flashUndo = (text: string) => { setUndoNote(text); window.clearTimeout(undoTimer.current); undoTimer.current = window.setTimeout(() => setUndoNote(""), 2000); };
  const stepHistory = (intent: UndoIntent) => {
    const word = intent === "undo" ? "撤销" : "恢复";
    if (!history) return flashUndo(`这里不能${word}`);
    if (locked) return flashUndo(`不能${word}：${locked}`);
    if (intent === "undo" ? !history.canUndo : !history.canRedo) return flashUndo(`没有可${word}的修改`);
    pendingUndo.current = { intent, before: queue };
    (intent === "undo" ? history.undo : history.redo)();
  };
  useCardUndoKeys(stepHistory);
  useEffect(() => {
    const pending = pendingUndo.current;
    if (!pending || pending.before === queue) return;
    pendingUndo.current = null;
    flashUndo(`${pending.intent === "undo" ? "已撤销" : "已恢复"}：${describeQueueChange(pending.before, queue)}`);
  }, [queue]);
  useEffect(() => () => window.clearTimeout(undoTimer.current), []);
  // Structure edits pin "previous" / shotNumber references to titles first, so moving shots never re-targets a chain.
  const onChange = (next: ShotQueue) => applyChange(next);
  // The page keeps running while an in-page question is open: re-check the lock after the answer.
  const lockNow = useRef(locked); lockNow.current = locked;
  const [catalog, setCatalog] = useState<{ roles: RoleRecord[]; assets: Map<string, AssetRecord> } | null>(null);
  const [catalogTick, setCatalogTick] = useState(0);
  const [error, setError] = useState("");
  const [overrides, setOverrides] = useState<Record<string, ClauseKind>>(readOverrides);
  const [ignores, setIgnores] = useState<Record<string, string[]>>(readIgnores);
  const [filter, setFilter] = useState<"all" | "bad" | "warn" | "duration">("all");
  const [videos, setVideos] = useState<Map<string, ShotVideos>>(new Map());
  // 视频格：哪一镜正在渲、渲了多久、后面的排第几（只读）
  const renders = useRenderStatuses(queue, canvas?.pageShots);
  const [book, setBook] = useState<CandidateBook>({});
  const [kfAssets, setKfAssets] = useState<Map<string, AssetRecord>>(new Map());
  const [jobs, setJobs] = useState<KeyframeJob[]>(keyframeJobs);
  const [lostJobs, setLostJobs] = useState(lostKeyframeJobs);
  useEffect(() => {
    let active = true;
    const refresh = () => { setJobs(keyframeJobs()); setLostJobs(lostKeyframeJobs()); void loadCandidates(queue.title).then(async (next) => {
      const ids = [...new Set([...Object.values(next).flat().map((item) => item.assetId), ...queue.chapters.flatMap((chapter) => chapter.shots.flatMap((shot) => shot.firstFrameAssetId ? [shot.firstFrameAssetId] : []))])];
      const found = await Promise.all(ids.map((id) => getAsset(id)));
      if (active) { setBook(next); setKfAssets(new Map(found.filter((asset): asset is AssetRecord => Boolean(asset)).map((asset) => [asset.assetId, asset]))); }
    }).catch(() => {}); };
    refresh();
    const unsubscribe = subscribeKeyframeJobs(refresh);
    return () => { active = false; unsubscribe(); };
  }, [queue]);
  const body = useRef<HTMLDivElement>(null);
  const { book: reviewBook } = useReviewBook();
  const [experimentFor, setExperimentFor] = useState<CardModel | null>(null);
  const [viewing, setViewing] = useState("");
  const [viewingRef, setViewingRef] = useState<{ key: string; tag: string } | null>(null);
  const demixRow = useDemixRow();
  const busyNow = useRef(busyLock); busyNow.current = busyLock;

  useEffect(() => {
    let active = true;
    void (async () => {
      const roles = await listRoles();
      const ids = new Set<string>();
      for (const shot of queue.chapters.flatMap((chapter) => chapter.shots)) {
        shot.sceneAssetIds.forEach((id) => ids.add(id));
        // First / last frames and storyboards too: planShotReferences needs every image the shot submits.
        for (const id of [shot.firstFrameAssetId, shot.lastFrameAssetId, shot.keyframe?.storyboardAssetId, ...(shot.timeAnchors ?? []).map((anchor) => anchor.assetId)]) if (id) ids.add(id);
        for (const roleId of shot.roleIds) {
          const role = roles.find((item) => item.roleId === roleId);
          if (role?.primaryAppearanceAssetId) ids.add(role.primaryAppearanceAssetId);
          if (role?.primaryVoiceAssetId) ids.add(role.primaryVoiceAssetId);
        }
      }
      const found = await Promise.all([...ids].map((id) => getAsset(id)));
      if (active) setCatalog({ roles, assets: new Map(found.filter((asset): asset is AssetRecord => Boolean(asset)).map((asset) => [asset.assetId, asset])) });
    })().catch((cause) => { if (active) setError(cause instanceof Error ? cause.message : "角色或素材读取失败"); });
    return () => { active = false; };
  }, [queue, catalogTick]);

  // Videos come only from H3 nodes on this canvas page made for the shot (props.shotTitle), never from other projects
  // with the same title. A node whose prompt differs from the card is an old version (stale).
  const [videoTick, setVideoTick] = useState(0);
  useEffect(() => {
    if (!canvas) return;
    let active = true;
    void (async () => {
      const nodes = canvas.pageShots();
      const [shots, runs] = await Promise.all([listShots(), listRuns()]);
      const shotById = new Map(shots.map((record) => [record.shotId, record]));
      const runById = new Map(runs.map((run) => [run.runId, run]));
      const next = new Map<string, ShotVideos>();
      for (const shot of queue.chapters.flatMap((chapter) => chapter.shots)) {
        const versions: Omit<VideoVersion, keyof Lettered>[] = [];
        for (const node of nodes.filter((item) => item.title === shot.title)) {
          const record = shotById.get(node.shotId); if (!record) continue;
          const done = record.runIds.map((id) => runById.get(id)).filter((run): run is NonNullable<typeof run> => Boolean(run && run.status === "completed" && run.outputAssetIds.length)).sort((a, b) => a.createdAt - b.createdAt);
          for (const run of done) for (const assetId of run.outputAssetIds) {
            if (record.deletedCandidateAssetIds?.includes(assetId)) continue;
            const asset = await getAsset(assetId); if (asset?.kind !== "video") continue;
            versions.push({ assetId, asset, shotId: record.shotId, nodeId: node.nodeId, adopted: record.adoptedAssetId === assetId, adoptedAt: record.adoptedAt, stale: node.prompt !== shot.prompt, createdAt: asset.createdAt, ...(run.zhengbenVersion ? { zhengben: run.zhengbenVersion } : {}) });
          }
        }
        if (!versions.length) continue;
        // 只有真正出片的占 A/B/C；去配乐版挂在原片字母下（「A · 去配乐」），不再变成 B。
        const labelled = letterVersions(versions.map((version) => ({ ...version, createdAt: version.asset.createdAt, derivationType: version.asset.derivationType, sourceVideoAssetId: version.asset.sourceVideoAssetId, musicRemovalPasses: version.asset.musicRemovalPasses })));
        const chosen = pickChosenVersion(labelled);
        next.set(shot.title, { versions: labelled, chosen });
      }
      if (active) setVideos(next);
    })().catch(() => {});
    return () => { active = false; };
  }, [queue, canvas, videoTick]);
  // 一镜不再排队 / 渲染（出完或没了）：马上重读视频，不等 20 秒那一轮。
  const renderKey = JSON.stringify([...renders.keys()].sort());
  const lastRenderKey = useRef(renderKey);
  useEffect(() => { const before = JSON.parse(lastRenderKey.current) as string[]; lastRenderKey.current = renderKey; if (before.some((title) => !renders.has(title))) setVideoTick((n) => n + 1); }, [renderKey, renders]);
  // 去配乐做完：结果是同一节点的新版本，重读一遍视频让它出现在卡片里。
  const demixDone = demixRow ? Object.values(demixRow.jobs).filter((job) => job.state === "done").length : 0;
  useEffect(() => { if (demixDone) setVideoTick((n) => n + 1); }, [demixDone]);
  // New renders land while the board is open: look again every 20 s and when the window regains focus (roles too).
  useEffect(() => {
    const again = () => { setVideoTick((n) => n + 1); };
    const roles = () => { setCatalogTick((n) => n + 1); again(); };
    const timer = window.setInterval(again, 20000);
    window.addEventListener("focus", roles);
    return () => { window.clearInterval(timer); window.removeEventListener("focus", roles); };
  }, []);

  useEffect(() => {
    // 「JSON / 进度」抽屉开着时，Escape 先收起抽屉（由抽屉自己处理）。
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape" && !event.isComposing && !isTypingTarget(event.target) && !document.querySelector(".rough-cut-panel, .ab-shade, .scv-shade, .sca-shade, .sc-queue-drawer") && !document.querySelector(".scf-menu")) { event.stopPropagation(); onClose(); } };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  // 提示词完整度（lib/zhengben-categories.ts 的类别表），按镜头 key 对应。
  const completeness = useMemo(() => {
    if (!catalog) return new Map<string, CategoryResult[]>();
    const nameOf = (id: string) => catalog.roles.find((role) => role.roleId === id)?.displayName ?? id;
    return new Map(queueCompleteness(queue, (shot) => ({ visible: shot.roleIds.filter((id) => !shot.offscreenRoleIds?.includes(id)).map(nameOf), all: shot.roleIds.map(nameOf) })).map((row) => [row.key, row.results]));
  }, [queue, catalog]);
  const gateConfirm = useGateConfirmations(queue);
  const baseCards = useMemo(() => catalog ? queue.chapters.map((chapter, c) => chapter.shots.map((_, s) => buildCard(queue, c, s, catalog.roles, catalog.assets, overrides))) : [], [queue, catalog, overrides]);
  // 正本 h3q check：队列一改就（停顿 1.2 秒后）重跑；结果按镜头并进每张卡的检查，标「正本 h3q」。
  const [h3q, setH3q] = useState<H3qState>({ state: "running" });
  const tableKey = `frameflow.shotCard.h3qTable.v1|${queue.title}`;
  const [tableFile, setTableFile] = useState(() => { try { return localStorage.getItem(tableKey) ?? ""; } catch { return ""; } });
  const [h3qRun, setH3qRun] = useState(0);
  useEffect(() => {
    let active = true;
    setH3q((current) => ({ ...current, state: "running" }));
    const timer = window.setTimeout(() => {
      void runH3qCheck(JSON.parse(shotQueueJson(queue)), { tableFile }).then((result) => {
        if (!active) return;
        if (!result.ok) { setH3q({ state: "fail", error: result.error, version: result.version }); return; }
        const parsed = parseH3qOutput(result.output, queue.chapters.flatMap((chapter) => chapter.shots.map((shot) => shot.title)));
        // 设定值里的问题 h3q 只报在「本集设定.…」上：抄到用到它的镜头，画面五项才拦得住。
        const report = parsed ? attachEpisodeH3qItems(parsed, queue) : null;
        setH3q(report ? { state: "ok", report, version: result.version, table: result.table, tableFile: result.tableFile, command: result.command } : { state: "fail", error: "h3q 的输出看不懂（没有「结果: ERROR …」那一行）", version: result.version });
      });
    }, 1200);
    return () => { active = false; window.clearTimeout(timer); };
  }, [queue, tableFile, h3qRun]);
  // 画面五项以 h3q 为准：h3q 跑成了、而且正本 ≥ v2026-11-11.4（才查五项）就用它的 [五项·…] ERROR；没跑成画布兜底；还在跑 = pending。
  const gateBasis: GateBasis | null = h3q.state === "running" ? null
    : h3q.state === "ok" && h3q.report && h3qChecksFive(h3q.version) ? { source: "h3q", report: h3q.report }
    : { source: "canvas", why: h3q.state === "fail" ? `h3q 没跑成：${h3q.error}` : `正本版本 ${h3q.version ?? "未知"} 早于 ${H3Q_FIVE_SINCE}，h3q 还不查五项` };
  const cards = useMemo(() => {
    let flatIndex = 0;
    return baseCards.map((chapter) => chapter.map((card) => {
      const at = flatIndex++;
      const h3qItems = gateBasis?.source === "h3q" ? gateBasis.report.shots[at] ?? [] : null;
      const gate: GateVerdict = { failing: shotGate(card.shot, completeness.get(card.key), h3qItems), by: gateBasis?.source ?? "pending", ...(gateBasis?.source === "canvas" ? { why: gateBasis.why } : {}) };
      const extra: ShotCheck[] = h3q.state === "fail" ? [{ code: "h3q_failed", level: "warn", source: "h3q", message: `正本 h3q 没跑成（${h3q.error}），这一镜的写法规则没有查，不能当作通过` }]
        : (h3q.report?.shots[at] ?? []).map((item): ShotCheck => ({ code: item.level === "ERROR" ? h3qFix(item.message) ?? `h3q:${item.message.slice(0, 48)}` : `h3q:${item.message.slice(0, 48)}`, level: item.level === "ERROR" ? "error" : item.level === "WARN" ? "warn" : "hint", source: "h3q", message: item.message }));
      // h3q 判五项时，画布自己的「五项漏写」不再重复列（h3q 的 [五项·…] ERROR 已在 extra 里）；h3q 没跑成时画布这条就是兜底，标明。
      // 用户在卡片里亲手确认过（正文没改）的镜头：两边的五项都不再算写错。
      const confirmedShot = Boolean(gateConfirm.lookup(card.shot));
      const own = card.checks.flatMap((check) => !check.code.startsWith("gate:") ? [check] : confirmedShot || gate.by === "h3q" ? [] : gate.by === "canvas" ? [{ ...check, message: `${check.message}【兜底：${gate.why}】` }] : [check]);
      const fromH3q = confirmedShot ? extra.filter((check) => !(check.source === "h3q" && check.level === "error")) : extra;
      const durationAdvice = h3q.state === "ok" ? durationAdviceOf(h3q.report?.shots[at]) : null;
      const chainHint = h3q.state === "ok" ? chainHintOf(h3q.report?.shots[at]) : null;
      const health = cardHealth(card.healthRaw, { h3q: h3q.state === "ok" ? h3q.report?.shots[at] ?? [] : null, h3qVersion: h3q.version, cardCodes: card.checks.map((check) => check.code) });
      return { ...card, gate, h3qItems, durationAdvice, chainHint, health, checks: [...own, ...fromH3q] };
    }));
  }, [baseCards, h3q, gateConfirm.lookup, completeness]);
  const flat = cards.flat();
  const shotCount = queue.chapters.reduce((sum, chapter) => sum + chapter.shots.length, 0);
  const totalSeconds = flat.reduce((sum, card) => sum + card.actual, 0);
  // 预计耗时（估算）: a shot counts as done once it has a usable video for its current prompt.
  const doneTitles = new Set(flat.filter((card) => { const chosen = videos.get(card.shot.title)?.chosen; return chosen && !chosen.stale; }).map((card) => card.shot.title));
  const estimate = queueEstimate(queue, (c, s) => doneTitles.has(queue.chapters[c].shots[s].title));
  const aspects = new Set(queue.chapters.flatMap((chapter) => chapter.shots.map((shot) => shot.aspect)));
  const officialCount = flat.filter((card) => card.official).length;
  const ignoreKey = (card: CardModel) => `${queue.title}|${card.shot.title}`;
  const setIgnore = (card: CardModel, code: string, ignore: boolean) => setIgnores((current) => {
    const key = ignoreKey(card); const set = new Set(current[key] ?? []);
    if (ignore) set.add(code); else set.delete(code);
    const next = { ...current, [key]: [...set] }; if (!set.size) delete next[key]; writeIgnores(next); return next;
  });
  const stateOf = (card: CardModel) => {
    const live = card.checks.filter((check) => !(ignores[ignoreKey(card)] ?? []).includes(check.code));
    return live.some((check) => check.level === "error") ? "bad" : live.some((check) => check.level === "warn") ? "warn" : "ok";
  };
  const errorCards = flat.filter((card) => stateOf(card) === "bad");
  const warnCards = flat.filter((card) => stateOf(card) === "warn");
  const move = useCallback((text: string, kind: ClauseKind) => setOverrides((current) => { const next = { ...current, [text]: kind }; writeOverrides(next); return next; }), []);
  const jump = (key: string) => { setFilter("all"); requestAnimationFrame(() => body.current?.querySelector(`#shot-card-${CSS.escape(key)}`)?.scrollIntoView({ behavior: "smooth", block: "start" })); };
  const visible = (card: CardModel) => filter === "all" || (filter === "duration" ? Boolean(card.durationAdvice) : stateOf(card) === filter);
  // 时长：正本 h3q「[时长]」提醒的镜头；整集「全部改成建议秒数」和「整集统一像素」都先在页面里问。
  const durationCards = flat.filter((card) => card.durationAdvice);
  const episodeMp = episodeMpState(queue);
  // 整份队列都没用关键帧：不显示「关键帧」列（lib/shot-card-view-rules.ts）
  const kfInUse = queueUsesKeyframes(queue.chapters.flatMap((chapter) => chapter.shots), (title) => (book[title]?.length ?? 0) > 0 || jobs.some((job) => job.queueTitle === queue.title && job.shotTitle === title));
  const fixAllDurations = async () => {
    const plan = planDurationFixes(queue, (c, s) => cards[c]?.[s]?.durationAdvice ?? null);
    if (!plan.rows.length) { setCutNote("没有要改的秒数（有建议的镜头已经是建议秒数，或建议看不懂）"); return; }
    if (locked) { setCutNote(`不能改：${locked}`); return; }
    if (!await askConfirm({ title: "全部改成建议秒数？", message: `按正本 h3q 的建议改 ${plan.rows.length} 镜的秒数（只改秒数，不改正文；可以撤销）：\n${plan.rows.map((row) => `「${row.title}」${row.from} 秒 → ${row.to} 秒`).join("\n")}`, confirmLabel: `改 ${plan.rows.length} 镜` })) return;
    if (lockNow.current) { setCutNote(`不能改：${lockNow.current}`); return; }
    const problem = onChange(plan.queue); if (problem) setCutNote(`没改成：${problem}`); else flashCut(`已把 ${plan.rows.length} 镜改成建议秒数（还没入队；Ctrl+Z 可撤销）`);
  };
  const unifyMp = async (value: MpPreset) => {
    const plan = planEpisodeMegapixels(queue, value);
    if (!plan.changed) { setCutNote(`全部镜头已经是 ${value.toFixed(2)} MP`); return; }
    if (locked) { setCutNote(`不能改：${locked}`); return; }
    if (!await askConfirm({ title: `整集统一像素 ${value.toFixed(2)}？`, message: `把 ${plan.changed} 镜的像素预算改成 ${value.toFixed(2)} MP（其余 ${flat.length - plan.changed} 镜已经是）。${value === 0.45 ? "0.45 是测试 / 小样用的。" : ""}可以撤销。`, confirmLabel: `改 ${plan.changed} 镜` })) return;
    if (lockNow.current) { setCutNote(`不能改：${lockNow.current}`); return; }
    const problem = onChange(plan.queue); if (problem) setCutNote(`没改成：${problem}`); else flashCut(`已把 ${plan.changed} 镜改成 ${value.toFixed(2)} MP（还没入队；Ctrl+Z 可撤销）`);
  };
  const loadImages = useCallback(() => listAssets("image").then((list) => list.filter((asset) => !asset.recycled)), []);
  /** Replace one shot (by chapter/index) and hand the whole queue back for validation. */
  const [pendingEdit, setPendingEdit] = useState("");
  const [saveNote, setSaveNote] = useState("");
  const dupTitles = useMemo(() => duplicateTitles(queue), [queue]);
  const saveAsNew = async () => {
    let n = 1, title = `${queue.title}·重渲`;
    while (title === queue.title) title = `${queue.title}·重渲${++n}`;
    if (!await askConfirm({ message: `另存为「${title}」并载入卡片（「JSON / 进度」抽屉里的队列文本会换成新的）？原队列的记录和已出的视频不动；新队列入队时只会渲染你留下的镜头。`, confirmLabel: "另存并载入" })) return;
    // Keyframe candidates are kept per queue title: copy them first so the new queue's cards show them.
    const text = shotQueueJson({ ...queue, title });
    void copyQueueCandidates(queue.title, title).catch(() => null).then((copied) => setSaveNote(onLoad(text) ?? (copied === null ? "关键帧候选没复制过去（读写失败），回原队列还能看到" : "")));
  };
  /** Problems as plain text for another AI: per shot, its title and each message. Ignored items are left out. */
  /** 复制给 AI 修改：文字由 lib/shot-card-ai-copy.ts 生成（类别说明取自正本类别表）。 */
  const aiCopy = useAiCopy();
  const aiShot = (card: CardModel): AiCopyShot => {
    const ignored = ignores[ignoreKey(card)] ?? [];
    return { code: splitTitle(card.shot.title, card.index).code, title: card.shot.title, chapter: queue.chapters[card.chapter]?.title ?? "",
      missing: (completeness.get(card.key) ?? []).filter((result) => result.state === "missing").map((result) => result.id),
      h3q: h3q.report?.shots[flat.findIndex((item) => item.key === card.key)] ?? [],
      // 「ID 字段写错了」那段已经写清楚的角色问题不再重复列（role_missing / role_appearance）
      canvas: card.checks.flatMap((check) => check.source !== "h3q" && !check.code.startsWith("gate:") && !ignored.includes(check.code) && !(card.refProblems.length && (check.code === "role_missing" || check.code === "role_appearance")) && (check.level === "error" || check.level === "warn") ? [{ level: check.level, message: check.message }] : []),
      idFixes: card.refProblems.map((problem) => ({ owner: problem.owner, fix: problem.fix })),
      // 开场空白不是完整度类别：没有 id，原话后面写上三种改法
      gate: (card.gate?.failing ?? []).map((item) => { const rule = isGateCategory(item.id as CategoryId) ? null : hardRuleById(item.id); return rule ? { label: `${item.label}（必改：${rule.rule}）`, note: withFixes(item.note, rule.fixes) } : { id: item.id as CategoryId, label: item.label, note: item.note }; }),
      health: (card.health?.items ?? []).map((entry) => entry.message),
      official: card.official, ...(card.official && card.dialogue.length ? { lines: card.dialogue } : {}),
      ...(gateConfirm.lookup(card.shot) ? { confirmed: gateConfirm.lookup(card.shot)!.reason } : {}) };
  };
  const copyForAi = (scope: string, list: CardModel[], withGeneral = false) => {
    const chapters = [...new Set((list.length ? list : flat).map((card) => queue.chapters[card.chapter]?.title ?? "").filter(Boolean))];
    aiCopy.copy({ queueTitle: queue.title, chapters, zhengbenVersion: h3q.version, scope: `${scope}${h3q.state === "fail" ? `（正本 h3q 这次没跑成：${h3q.error ?? ""}，h3q 的问题没有列进来）` : ""}`, shots: list.map(aiShot), general: withGeneral ? h3q.report?.general : undefined });
  };
  const [cutting, setCutting] = useState<ReturnType<typeof canvasCutList> | null>(null);
  const [cutNote, setCutNote] = useState("");
  // 改完的轻提示：几秒后自己淡出（别的提示照旧常驻）。
  const [cutFade, setCutFade] = useState(false);
  const cutTimer = useRef(0);
  const flashCut = (text: string) => { window.clearTimeout(cutTimer.current); setCutFade(false); setCutNote(text); cutTimer.current = window.setTimeout(() => { setCutFade(true); cutTimer.current = window.setTimeout(() => { setCutNote((now) => now === text ? "" : now); setCutFade(false); }, 600); }, 3500); };
  useEffect(() => () => window.clearTimeout(cutTimer.current), []);
  /** 从 JSON 导入台词: preview in the page, write only after 确认; unmatched items are listed, never dropped silently. */
  const [importOpen, setImportOpen] = useState(false);
  const [importText, setImportText] = useState("");
  const [importNote, setImportNote] = useState("");
  const importLines = async () => {
    setImportNote("");
    const plan = planDialogueImport(importText, queue, catalog?.roles ?? []);
    if ("error" in plan) { setImportNote(plan.error); return; }
    if (!plan.changes.length) { setImportNote(`没有可导入的台词。${plan.unmatched.length ? `对不上的：${plan.unmatched.join("；")}` : ""}`); return; }
    if (!await askConfirm({ title: "导入台词", message: importSummary(plan), confirmLabel: `导入 ${plan.changes.length} 处` })) { setImportNote("已取消，没有改动"); return; }
    if (lockNow.current) { setImportNote(lockNow.current); return; }
    const applied = applyDialogueImport(queue, plan);
    if ("error" in applied) { setImportNote(`没导入：${applied.error}`); return; }
    const problem = onChange(applied);
    if (problem) { setImportNote(`没导入：${problem}`); return; }
    setImportOpen(false); setImportText("");
    setImportNote(`已导入 ${plan.changes.length} 处台词，点「撤销」可以退回。${plan.unmatched.length ? `没导入的 ${plan.unmatched.length} 处：${plan.unmatched.join("；")}` : ""}`);
  };
  /** 一键粗剪: every card that has a video, in card order (adopted first, else newest), hard cut through the canvas rough-cut pipeline. */
  const roughCut = async () => {
    setCutNote("");
    const stale = flat.filter((card) => videos.get(card.shot.title)?.chosen?.stale);
    const useStale = stale.length > 0 && await askConfirm({ message: `${stale.length} 镜只有旧提示词出的视频（卡片里的提示词已经改过）。确定也拼进去吗？取消就跳过它们。`, confirmLabel: "也拼进去", cancelLabel: "跳过它们" });
    const withVideo = flat.filter((card) => { const chosen = videos.get(card.shot.title)?.chosen; return chosen && (!chosen.stale || useStale); });
    const missing = flat.length - withVideo.length;
    if (!withVideo.length) { setCutNote("还没有任何一镜渲出可用的视频，粗剪不了"); return; }
    if (missing && !await askConfirm({ message: `${missing} 镜没有可用视频，粗剪会跳过它们，只拼 ${withVideo.length} 镜。继续？`, confirmLabel: "继续粗剪" })) return;
    try {
      setCutting(canvasCutList(withVideo.map((card) => { const video = videos.get(card.shot.title)!.chosen!; const duration = video.asset.duration && video.asset.duration > 0 ? video.asset.duration : card.actual; return { nodeId: `card-${card.key}`, asset: video.asset, inPoint: 0, outPoint: duration, duration }; }), crypto.randomUUID()));
    } catch (cause) { setCutNote(cause instanceof Error ? cause.message : "粗剪清单建不起来"); }
  };
  const structureLocked = locked;
  const allTitles = () => new Set(queue.chapters.flatMap((chapter) => chapter.shots.map((shot) => shot.title)));
  const pinned = () => pinRelativeReferences(queue);
  const withShots = (c: number, shots: ShotQueueShot[]) => { const base = pinned(); return { ...base, chapters: base.chapters.map((chapter, i) => i === c ? { ...chapter, shots } : chapter) }; };
  const shotsOf = (c: number) => [...pinned().chapters[c].shots];
  const duplicateShot = (card: CardModel) => {
    const titles = allTitles();
    let n = 2, title = `${card.shot.title}·副本`;
    while (titles.has(title)) title = `${card.shot.title}·副本${n++}`;
    const shots = shotsOf(card.chapter);
    const copy: ShotQueueShot = structuredClone(shots[card.index]);
    copy.title = title; delete copy.shotId; delete copy.autoVoiceAssigned;
    shots.splice(card.index + 1, 0, copy);
    const problem = onChange(withShots(card.chapter, shots));
    if (!problem) { void copyCandidates(queue.title, card.shot.title, title); setPendingEdit(title); setFilter("all"); requestAnimationFrame(() => body.current?.querySelector(`[data-title="${CSS.escape(title)}"]`)?.scrollIntoView({ behavior: "smooth", block: "center" })); }
    return problem;
  };
  const removeShot = (card: CardModel) => {
    if (queue.chapters[card.chapter].shots.length === 1 && queue.chapters.length === 1) return "队列只剩这一镜，不能删";
    const needed = dependentsOf(queue, card.shot.title);
    if (needed.length) return `「${needed.join("」「")}」要接这一镜的画面，先改掉它们的接帧再删`;
    const shots = shotsOf(card.chapter).filter((_, s) => s !== card.index);
    const base = pinned();
    return onChange(shots.length ? withShots(card.chapter, shots) : { ...base, chapters: base.chapters.filter((_, c) => c !== card.chapter) });
  };
  const shiftShot = (card: CardModel, delta: -1 | 1) => {
    const shots = shotsOf(card.chapter); const to = card.index + delta;
    if (to < 0 || to >= shots.length) return delta < 0 ? "已经是本章第一镜" : "已经是本章最后一镜";
    [shots[card.index], shots[to]] = [shots[to], shots[card.index]];
    return onChange(withShots(card.chapter, shots));
  };
  const saveShot = (card: CardModel, shot: ShotQueueShot) => onChange({ ...queue, chapters: queue.chapters.map((chapter, c) => c !== card.chapter ? chapter : { ...chapter, shots: chapter.shots.map((item, s) => s === card.index ? shot : item) }) });
  const runKeyframes = (card: CardModel, count?: number) => {
    if (!card.shot.keyframe) return "这一镜没有关键帧描述，先点「编辑这一镜」写";
    try { enqueueKeyframes({ queueTitle: queue.title, shotTitle: card.shot.title, aspect: card.shot.aspect, keyframe: card.shot.keyframe, defaults: queue.defaults?.keyframe, roles: catalog?.roles ?? [], count }); return null; }
    catch (cause) { return cause instanceof Error ? cause.message : "关键帧排不进去"; }
  };
  /** 通过 = this image becomes the first frame (first-last mode). The first frame takes Picture 1, so <Picture N> tags move up by one. */
  const approveKeyframe = async (card: CardModel, assetId: string | null) => {
    const shot = card.shot;
    const next: ShotQueueShot = { ...shot };
    if (assetId) {
      next.firstFrameAssetId = assetId; next.generationMode = "first-last";
      // 正本：首帧不占 Picture 编号；提交时画布自己把编号往后挪（prepareKeyframeSubmission），这里不改提示词。
    } else {
      delete next.firstFrameAssetId;
      if (!shot.lastFrameAssetId && !shot.lastFrameFrom) delete next.generationMode;
    }
    if (lockNow.current) return lockNow.current;
    return saveShot(card, next);
  };
  const candidatesFor = (card: CardModel): KeyframeCandidateView[] => (book[card.shot.title] ?? []).map((item) => ({ assetId: item.assetId, src: kfAssets.get(item.assetId)?.storageReference ?? "", rejected: Boolean(item.rejected) }));
  const kfShots = flat.filter((card) => card.shot.keyframe && !card.shot.firstFrameAssetId && !card.shot.firstFrameFrom);
  const kfTodo = kfShots.filter((card) => !(book[card.shot.title] ?? []).some((item) => !item.rejected) && !jobs.some((job) => job.shotTitle === card.shot.title && job.queueTitle === queue.title));
  const runAllKeyframes = () => { const problems = kfTodo.map((card) => runKeyframes(card)).filter(Boolean); setCutNote(problems.length ? `有 ${problems.length} 镜排不进去：${problems[0]}` : `已排 ${kfTodo.length} 镜关键帧，一张一张出`); };
  /** 用尾帧做视频: a new shot right below, same settings, first frame = this shot's last frame. */
  const chainFromTail = async (card: CardModel) => {
    const titles = allTitles();
    let n = 2, title = `${card.shot.title}·续`;
    while (titles.has(title)) title = `${card.shot.title}·续${n++}`;
    const shots = shotsOf(card.chapter);
    const next: ShotQueueShot = structuredClone(shots[card.index]);
    next.title = title; delete next.shotId; delete next.autoVoiceAssigned; delete next.keyframe; delete next.firstFrameAssetId; delete next.timeAnchors; delete next.sourceShot; delete next.sourceVideoAssetId;
    // 正本：首帧不占 Picture 编号，新镜头的提示词原样复制；提交时画布自己把编号往后挪。
    next.generationMode = "first-last"; next.firstFrameFrom = { shot: card.shot.title, frame: "last" };
    if (lockNow.current) return lockNow.current;
    shots.splice(card.index + 1, 0, next);
    const problem = onChange(withShots(card.chapter, shots));
    if (!problem) { setPendingEdit(title); setFilter("all"); requestAnimationFrame(() => body.current?.querySelector(`[data-title="${CSS.escape(title)}"]`)?.scrollIntoView({ behavior: "smooth", block: "center" })); }
    return problem;
  };
  /** 接尾帧提示的「一键接上」：这一镜改成接上一镜尾帧（进撤销历史；入队过 / 提交中照常拦）。 */
  const chainUp = (card: CardModel): string | null => {
    if (!card.chainHint) return "正本 h3q 没有建议这一镜接尾帧";
    if (lockNow.current) return lockNow.current;
    const result = applyChainHint(card.shot, queue.chapters[card.chapter].shots[card.index - 1], card.chainHint);
    if ("problem" in result) return result.problem;
    const problem = saveShot(card, result.shot);
    if (!problem) setCutNote(result.note);
    return problem;
  };
  /** 渲染这一镜: the same node the queue would build (same props, frames, seed rule), then the node's own 生成. */
  const renderOne = async (card: CardModel): Promise<string | null> => {
    if (!canvas || !catalog) return "画布还没准备好";
    const shot = card.shot;
    try {
      const existing = canvas.pageShots().filter((node) => node.title === shot.title && node.prompt === shot.prompt).pop();
      let nodeId = existing?.nodeId;
      if (!nodeId) {
        const plan = planRefs(shot, catalog.roles, catalog.assets);
        const frame = (id?: string) => { if (!id) return undefined; const asset = catalog.assets.get(id); if (!asset) throw new Error("首尾帧图片找不到：" + id); return { src: asset.storageReference, name: asset.filename, sourceNodeId: "" }; };
        const props = shotQueueH3Props(shot, plan, queue.defaults);
        const seed = props.seedMode === "随机" ? String(crypto.getRandomValues(new Uint32Array(1))[0]) : props.seed;
        const node = await canvas.createNode({ ...props, seedMode: "固定", seed, ...(shot.firstFrameAssetId ? { videoFirstFrame: frame(shot.firstFrameAssetId) } : {}), ...(shot.lastFrameAssetId ? { videoLastFrame: frame(shot.lastFrameAssetId) } : {}) });
        if (!node) return "节点没建出来";
        nodeId = node.id;
      }
      canvas.focus(nodeId);
      // Wait for the node to mount and finish its own checks (same 12 s budget the queue uses).
      let state = readH3Automation(nodeId);
      for (let i = 0; i < 48 && (!state || state.busy); i++) { await new Promise((resolve) => setTimeout(resolve, 250)); canvas.focus(nodeId); state = readH3Automation(nodeId); }
      if (!state) return "节点还没在画布上显示出来，滚到它那里再点一次";
      if (state.busy) return "这个节点正在生成，等它出完";
      if (!state.preflight.ok) return "节点检查没过：" + state.preflight.errors.map((error) => error.message).join("；");
      void state.generate().then(() => setVideoTick((n) => n + 1)).catch(() => {});
      return null;
    } catch (cause) { return cause instanceof Error ? cause.message : "渲染没提交出去"; }
  };
  const renderBlock = (card: CardModel) => !canvas ? "要在画布里打开卡片才能渲染" : busyLock || (card.shot.firstFrameFrom || card.shot.lastFrameFrom || card.shot.sourceShot || card.shot.timeAnchors?.some((anchor) => anchor.frameFrom) ? "这一镜要接别的镜头的画面，请用「JSON / 进度」里的入队（它会等来源出片再截帧）" : card.gate?.by === "pending" && !gateConfirm.lookup(card.shot) ? "正本 h3q 还在查画面五项，稍等几秒再点" : shotGateMessage(card.shot, completeness.get(card.key), gateConfirm.lookup, card.h3qItems, gateBasis ?? undefined));
  const chooseVersion = async (version: VideoVersion) => {
    try { await adoptShotAsset(version.shotId, version.assetId); readH3Automation(version.nodeId)?.choose(version.assetId); setVideoTick((n) => n + 1); return null; }
    catch (cause) { return cause instanceof Error ? cause.message : "没能选用这一条"; }
  };
  /** 一键选预设：只换本镜直接写回；整集都换先确认。都是改队列，照常进撤销 / 恢复。 */
  const applyPreset = async (card: CardModel, scope: "shot" | "episode", edit: PresetEdit): Promise<string | null> => {
    if (lockNow.current) return lockNow.current;
    if (scope === "shot") {
      const next = planShotPreset(card.shot.prompt, edit);
      if (next.prompt === card.shot.prompt) return "这一镜没有变化";
      return saveShot(card, { ...card.shot, prompt: next.prompt });
    }
    const plan = planEpisodePreset(queue, card.chapter, card.index, edit);
    if (!plan.changed.length) return "没有镜头需要改";
    if (!await askConfirm({ title: "整集都换", message: `会改 ${plan.changed.length} 镜：${plan.episodeKey ? `这一句来自本集设定「${plan.episodeKey}」，直接改设定，用到它的镜头一起变；另外` : ""}这一句和「${card.shot.title}」原来那句一字不差的镜头一起换。${plan.skipped.length ? `另有 ${plan.skipped.length} 镜这一句写法不同，不动。` : ""}改完可以点「撤销」退回。`, confirmLabel: `换 ${plan.changed.length} 镜` })) return "已取消，没有改动";
    if (lockNow.current) return lockNow.current;
    return onChange(plan.queue);
  };
  /** 视频列里「看去配乐版 / 切回原声」= 选用那一条（和点 A/B/C 一样）。 */
  const showDemixVersion = (v: ShotVideos, assetId: string) => {
    const target = v.versions.find((item) => item.assetId === assetId);
    if (!target) { setVideoTick((n) => n + 1); setCutNote("去配乐版还没进卡片，过几秒再点一次"); return; }
    void chooseVersion(target).then((problem) => { if (problem) setCutNote(problem); });
  };
  const autoDemix = queue.defaults?.autoRemoveMusic ?? true;
  const toggleAutoDemix = () => { if (lockNow.current) { setCutNote(lockNow.current); return; } const problem = onChange({ ...queue, defaults: { ...queue.defaults, autoRemoveMusic: !autoDemix } }); setCutNote(problem ?? `出片后自动去配乐：已改成${autoDemix ? "关" : "开"}（只影响之后的出片，可以撤销）`); };
  const episodeDemix = async () => {
    const items = flat.flatMap((card) => { const v = videos.get(card.shot.title); const chosen = v?.chosen; return v && chosen ? [{ title: card.shot.title, code: splitTitle(card.shot.title, card.index).code, asset: chosen.asset, nodeId: chosen.nodeId, duration: chosen.asset.duration && chosen.asset.duration > 0 ? chosen.asset.duration : card.actual, versions: v.versions.map((item) => item.asset) }] : []; });
    setCutNote(await runEpisodeDemix(items, flat.length - items.length, demixRow));
  };
  const ctxFor = (card: CardModel): EditCtx => ({ gate: gateConfirm.rowFor(card.shot), episode: queue.episode, roles: catalog?.roles ?? [], images: loadImages, assets: catalog?.assets ?? new Map(), locked, save: (shot) => saveShot(card, shot),
    duplicate: () => duplicateShot(card), remove: () => removeShot(card), shift: (delta) => shiftShot(card, delta), structureLocked, startEditing: pendingEdit === card.shot.title,
    render: () => renderOne(card), chainFromTail: () => chainFromTail(card), chainUp: () => chainUp(card), canRender: renderBlock(card), choose: chooseVersion,
    candidates: candidatesFor(card), jobs: jobs.filter((job) => job.queueTitle === queue.title && job.shotTitle === card.shot.title), keyframeDefaults: queue.defaults?.keyframe,
    estimate: shotEstimate(card.shot, queue.defaults), lockNow: () => lockNow.current,
    preset: { prompt: card.shot.prompt, names: card.names, locked, apply: (scope, edit) => applyPreset(card, scope, edit), episodePlan: (edit) => { const plan = planEpisodePreset(queue, card.chapter, card.index, edit); return { changed: plan.changed.length, skipped: plan.skipped.length }; } },
    review: (v) => <VideoReview videos={v.versions.map((item) => ({ assetId: item.assetId, label: item.reviewLabel, zhengben: item.zhengben }))} chosenId={v.chosen?.assetId ?? ""} ctx={{ book: reviewBook, queueTitle: queue.title, shot: card.shot, defaults: queue.defaults, experiment: experimentContext(queue, card.shot.title) }} />,
    experiment: busyLock ? undefined : () => setExperimentFor(card), zoom: () => setViewing(card.shot.title), copyForAi: () => copyForAi("这一镜", [card]), zoomRef: (tag) => setViewingRef({ key: card.key, tag }),
    locate: (() => {
      if (!canvas) return undefined;
      const pages = canvas.pageShots();
      const fromRow = nodeIds?.[card.key];
      const targetId = (fromRow && pages.some((item) => item.nodeId === fromRow) ? fromRow : undefined)
        ?? pages.filter((item) => item.title === card.shot.title).pop()?.nodeId;
      return targetId ? () => { onClose(); canvas.focus(targetId, true); } : undefined;
    })(),
    demix: (v) => v.chosen && <DemixCardControl asset={v.chosen.asset} nodeId={v.chosen.nodeId} versions={v.versions.map((item) => item.asset)} row={demixRow} showHint="点了会选用这一条（粗剪也用它），和点 A/B/C 一样" onShow={(assetId) => showDemixVersion(v, assetId)} />,
    runKeyframes: (count) => runKeyframes(card, count), approve: (assetId) => approveKeyframe(card, assetId), reject: (assetId, rejected) => { void setRejected(queue.title, card.shot.title, assetId, rejected).then(() => setBook((current) => ({ ...current, [card.shot.title]: (current[card.shot.title] ?? []).map((item) => item.assetId === assetId ? { ...item, rejected } : item) }))); } });
  const musicCards = flat.filter((card) => namesMusic(card.shot.prompt));
  const [bulkError, setBulkError] = useState("");
  const fixAllMusic = () => {
    const touched = new Set(musicCards.map((card) => card.shot));
    setBulkError(onChange({ ...queue, chapters: queue.chapters.map((chapter) => ({ ...chapter, shots: chapter.shots.map((shot) => touched.has(shot) ? { ...shot, prompt: removeMusicSentences(shot.prompt) } : shot) })) }) ?? "");
  };

  return createPortal(<div className="sc-root" role="dialog" aria-modal="true" aria-label="镜头卡片" onPointerDown={(event) => event.stopPropagation()} onWheel={(event) => event.stopPropagation()}>
    <style>{STYLE + PRESET_STYLE + SC_HEADER_STYLE + EPISODE_STYLE + REVIEW_STYLE + EXPERIMENT_STYLE + VIEWER_STYLE + DEMIX_CARD_STYLE + AI_COPY_STYLE + RENDER_STATUS_STYLE}</style>
    <header className="sc-slate-head scf-head" ref={headRef} title="渲染前检查 · 点「渲染这一镜」「出关键帧」会用显卡">
      <div className="scf-line1">
        <h2 title={queue.title}>{queue.title}</h2>
        <span className="scf-meta"><b>{shotCount}</b> 镜 · <b title="实际总时长">{Math.floor(totalSeconds / 60)}:{String(Math.round(totalSeconds % 60)).padStart(2, "0")}</b></span>
        <div className="sc-head-actions">
        {queueDrawer && <button type="button" className={`sc-btn ${queueDrawer.open ? "on" : ""}`} aria-expanded={queueDrawer.open} title="JSON / 进度：粘贴、载入、导出、换队列、填示例、检查；全部入队／继续未完成、本章入队、停止后续排队、排队进度；收件箱自动入队 / 急停；导出台词清单；程序体检" onClick={queueDrawer.toggle}>JSON / 进度{queueDrawer.busy ? <small> · 提交中</small> : null}</button>}
        {queueDrawer?.enqueue && <button type="button" className="sc-btn primary sc-enqueue" disabled={queueDrawer.enqueue.disabled} title={queueDrawer.enqueue.title} onClick={queueDrawer.enqueue.all}>{queueDrawer.enqueue.label}</button>}
        {queueDrawer?.enqueue?.stop && <button type="button" className="sc-btn" disabled={queueDrawer.enqueue.stopping} title="停止后续排队：保留正在执行的镜头，后面的不再提交；停完在「JSON / 进度」里写明停了几镜" onClick={queueDrawer.enqueue.stop}>{queueDrawer.enqueue.stopping ? "正在停止…" : "停止后续排队"}</button>}
        {queueDrawer?.enqueue?.forceUnlock && <button type="button" className="sc-btn" title="提交循环几秒内没退出：点了先问你，写明后果；不取消 ComfyUI 里的任务" onClick={queueDrawer.enqueue.forceUnlock}>强制解锁</button>}
        <button type="button" className="sc-btn" onClick={roughCut} title="按卡片顺序把已渲出的视频硬切拼成一条（已采用的优先，否则用最新一条）">一键粗剪 <small>{videos.size}/{shotCount} 镜有视频</small></button>
        <button type="button" className="sc-btn" disabled={!videos.size} title="每镜视频列当前显示的那条，还没去过配乐的，排队去配乐（一条一个任务，排在出片后面）；先在页面里确认处理几条、跳过几条" onClick={() => void episodeDemix()}>整集去配乐</button>
        {history && <><button type="button" className="sc-btn" disabled={!!locked || !history.canUndo} title={locked || `撤销上一次修改（Ctrl+Z；本队列最近 20 版，当前${history.label}）`} onClick={() => stepHistory("undo")}>撤销</button><button type="button" className="sc-btn" disabled={!!locked || !history.canRedo} title={locked || `恢复刚才撤销的修改（Ctrl+Y 或 Ctrl+Shift+Z；当前${history.label}）`} onClick={() => stepHistory("redo")}>恢复</button></>}
        {incoming?.hidden && <button type="button" className="sc-btn" onClick={incoming.switchTo}>新队列待切换（{incoming.count}）</button>}
        <button type="button" className="sc-btn" title="换一份队列 JSON（会覆盖「JSON / 进度」里的文本，先确认）" onClick={onReplace}>换队列 JSON</button>
        <ScMoreMenu>
          <button type="button" role="menuitem" title="复制一份说明：队列格式、第一集写法摘要（以正本为准）、完整度类别、正本 h3q 和画布两套检查。发给写队列的 AI，它就照这个写" onClick={() => void copyPlainText(SHOT_CARD_GUIDE, "已复制卡片功能说明")}>复制卡片功能说明</button>
          {exportJson && <button type="button" role="menuitem" title="把现在的队列 JSON（含卡片里的修改）存成文件" onClick={exportJson}>导出 JSON</button>}
          <button type="button" role="menuitem" disabled={!!locked} title={locked || "粘贴整份队列，或 { \"镜头标题\": { \"角色名\": [\"台词\"] } }，按镜头标题和角色名填进台词"} onClick={() => { setImportOpen((value) => !value); setImportNote(""); }}>从 JSON 导入台词</button>
          {catalog && errorCards.length > 0 && <button type="button" role="menuitem" title="把所有写错的镜头和原因复制下来，发给 AI 改提示词" onClick={() => copyForAi("写错的镜头", errorCards)}>复制写错的镜头和原因</button>}
          {catalog && warnCards.length > 0 && <button type="button" role="menuitem" title="把只有漏写的镜头和原因复制下来，发给 AI 补写" onClick={() => copyForAi("漏写的镜头", warnCards)}>复制漏写的镜头和原因</button>}
        </ScMoreMenu>
        {undoNote && <span className="scf-copied scf-undo" role="status">{undoNote}</span>}
        <button type="button" className="sc-close" aria-label="关闭镜头卡片" onClick={onClose}><X size={18} /></button>
        </div>
      </div>
      <div className="scf-stats">
        <button type="button" className={`${catalog && errorCards.length ? "bad" : ""} ${filter === "bad" ? "on" : ""}`} title="有写错的镜头 · 点击只看这些，再点恢复全部" onClick={() => setFilter(filter === "bad" ? "all" : "bad")}>写错 <b>{catalog ? errorCards.length : "–"}</b></button>
        {catalog && errorCards.length > 0 && <button type="button" className="scf-ai" aria-label="复制写错的镜头给 AI 修改" title={`复制给 AI 修改：写错的 ${errorCards.length} 镜（${errorCards.slice(0, 8).map((card) => splitTitle(card.shot.title, card.index).code).join("、")}${errorCards.length > 8 ? " 等" : ""}），每镜的原因和怎么改`} onClick={() => copyForAi("写错的镜头", errorCards)}><ClipboardCopy size={12} />复制</button>}
        <button type="button" className={`${catalog && warnCards.length ? "warn" : ""} ${filter === "warn" ? "on" : ""}`} title="只有漏写的镜头 · 点击只看这些，再点恢复全部" onClick={() => setFilter(filter === "warn" ? "all" : "warn")}>漏写 <b>{catalog ? warnCards.length : "–"}</b></button>
        {catalog && warnCards.length > 0 && <button type="button" className="scf-ai" aria-label="复制漏写的镜头给 AI 修改" title={`复制给 AI 修改：只有漏写的 ${warnCards.length} 镜（${warnCards.slice(0, 8).map((card) => splitTitle(card.shot.title, card.index).code).join("、")}${warnCards.length > 8 ? " 等" : ""}），每镜漏了什么、怎样才算写到`} onClick={() => copyForAi("漏写的镜头", warnCards)}><ClipboardCopy size={12} />复制</button>}
        <span title="检查通过的镜头">通过 <b>{catalog ? flat.length - errorCards.length - warnCards.length : "–"}</b></span>
        <button type="button" className={h3q.state === "fail" || (h3q.report?.counts.ERROR ?? 0) > 0 ? "bad" : (h3q.report?.counts.WARN ?? 0) > 0 ? "warn" : ""} title="正本 h3q：ERROR / WARN / HINT · 点击展开详情" onClick={() => openFold("h3q")}>h3q <b>{h3q.state === "fail" ? "没跑成" : h3q.report ? `${h3q.report.counts.ERROR}/${h3q.report.counts.WARN}/${h3q.report.counts.HINT}` : "…"}</b></button>
        {durationCards.length > 0 && <button type="button" className={`warn ${filter === "duration" ? "on" : ""}`} title="正本 h3q 说这几镜内容和秒数不太相符（只提醒，不拦截入队）· 点击只看这些，再点恢复全部" onClick={() => setFilter(filter === "duration" ? "all" : "duration")}><b>{durationCards.length}</b> 镜时长可能不合适</button>}
        <span className="scf-mp" title={locked || "整集统一像素：点一下把全部镜头改成这个值，先问你改几镜；0.45 = 测试 / 小样"}>整集像素{MP_PRESETS.map((value) => <button key={value} type="button" aria-pressed={episodeMp.current === value} className={episodeMp.current === value ? "on" : ""} disabled={!!locked} onClick={() => void unifyMp(value)}>{value.toFixed(2)}</button>)}{episodeMp.current === null && <em>{episodeMp.mixed || `现在 ${episodeMp.counts[0]?.value ?? ""}`}</em>}</span>
        {officialCount > 0 && <span title={`${officialCount} 镜是官方 Ref2VA 六段式：正文原样提交，配乐只看正文 non_diegetic_music（N/A = 不要配乐），「禁背景乐」对这些镜头不加句子`}><b>{OFFICIAL_MUSIC_NOTE}</b>{officialCount < flat.length ? `（${officialCount}/${flat.length} 镜）` : ""}</span>}
        {officialCount < flat.length && <span className={queue.defaults?.noBackgroundMusic ? "" : "warn"}><b>{queue.defaults?.noBackgroundMusic ? "禁背景乐" : "未禁背景乐"}</b></span>}
        {aspects.size > 1 && <span className="warn">比例混用 {[...aspects].join("/")}</span>}
        <button type="button" className={autoDemix ? "" : "warn"} disabled={!!locked} title={locked || `队列默认设置 defaults.autoRemoveMusic：每条出片完成后自动排一次去配乐（原声版保留）。点一下改成${autoDemix ? "关" : "开"}；算修改队列，可以撤销；只影响之后的出片，单镜写了 autoRemoveMusic 的以单镜为准`} onClick={toggleAutoDemix}>出片后自动去配乐 <b>{autoDemix ? "开" : "关"}</b></button>
        <span title={ESTIMATE_NOTE}>⏱ 预计 {formatEstimate(estimate.total)}{estimate.left < estimate.shots ? ` · 剩 ${estimate.left} 镜` : ""} · 估算</span>
      </div>
    </header>

    {incoming && !incoming.hidden && <div className="sc-bulk kf" role="status"><span>收件箱来了新队列「{incoming.file}」{incoming.count > 1 ? `（共 ${incoming.count} 份，切换的是最新一份）` : ""}。你正在看的「{queue.title}」没有被换掉，卡片里的修改都还在。</span><button type="button" className="sc-btn" onClick={incoming.switchTo}>切换到新队列</button><button type="button" className="sc-btn" onClick={incoming.later}>稍后</button></div>}
    {(importOpen || importNote) && <div className="sc-bulk sc-lines-import">
      {importOpen && <><span>粘贴 JSON：整份队列（读每镜正文的「对白」行，旧队列读 dialogue），或 {"{ \"镜头标题\": { \"角色名\": [\"第一句\", \"第二句\"] } }"}。按镜头标题 + 角色名对上后，先给你看会改哪些，再确认；台词写进正文「对白」那一行，不写 dialogue。</span>
        <textarea className="sc-input mono" rows={5} value={importText} spellCheck={false} onChange={(event) => setImportText(event.target.value)} />
        <button type="button" className="sc-btn primary" disabled={!importText.trim() || !!locked} onClick={() => void importLines()}>预览并导入</button><button type="button" className="sc-btn" onClick={() => { setImportOpen(false); setImportNote(""); }}>收起</button></>}
      {importNote && <span role="status">{importNote}</span>}
    </div>}

    <div className={`sc-reel ${kfInUse ? "" : "no-kf"}`} ref={body}>
      <div className="scf-top">
        <ScFoldBar items={[
          { id: "h3q", label: "正本 h3q", tone: h3q.state === "fail" || (h3q.report?.counts.ERROR ?? 0) > 0 ? "bad" : (h3q.report?.counts.WARN ?? 0) > 0 ? "warn" : "plain",
            summary: h3q.state === "fail" ? `没跑成：${h3q.error ?? ""}，不能当作通过` : h3q.report ? `ERROR ${h3q.report.counts.ERROR} · WARN ${h3q.report.counts.WARN} · HINT ${h3q.report.counts.HINT}${h3q.version ? ` · 正本 ${h3q.version}` : ""}${h3q.state === "running" ? " · 正在重查…" : ""}` : "正在检查…",
            content: <>{catalog && <div className="sca-row"><AiCopyButton title="把正本 h3q 报的问题（逐镜原文 + 整集条目）连同漏写、画面五项复制成一段中文，贴给 AI 改" onCopy={() => copyForAi("正本 h3q 报了问题的镜头", flat.filter((card) => (h3q.report?.shots[flat.indexOf(card)] ?? []).length > 0), true)} /></div>}<H3qBar h3q={h3q} tableFile={tableFile} setTableFile={(value) => { setTableFile(value); try { if (value) localStorage.setItem(tableKey, value); else localStorage.removeItem(tableKey); } catch { /* per-browser convenience */ } }} rerun={() => setH3qRun((n) => n + 1)} /></> },
          (() => { const digest = healthDigest(flat.map((card) => card.health)); const rows = flat.filter((card) => (card.health?.items.length ?? 0) > 0);
            return { id: "health", label: "程序体检", tone: "plain" as const, summary: digest.text, content: <><div className="sca-row"><AiCopyButton title="把有程序体检提示的镜头（体检提示 + 漏写、正本 h3q、画面五项）复制成一段中文，贴给 AI 改" onCopy={() => copyForAi("有程序体检提示的镜头", rows)} /></div>
              <div className="pc-summary"><p className="pc-rule">画布自己的提醒（语速、帧数对齐、动作节点、首帧第一句、声音、画外音、锚点），只是提醒，不拦截入队；和正本冲突时听正本。和正本 h3q 或卡片别处重复的已合并成一条，不显示两遍。</p>
                {rows.length ? <div className="pc-table-wrap"><table className="pc-table"><thead><tr><th>镜头</th><th>体检提示</th></tr></thead><tbody>{rows.map((card) => <tr key={card.key}>
                  <td><button type="button" onClick={() => jump(card.key)} title={card.shot.title}>{splitTitle(card.shot.title, card.index).code}</button></td>
                  <td><ul className="sc-health">{card.health!.items.map((entry, i) => <li key={i}>{entry.message}</li>)}</ul></td>
                </tr>)}</tbody></table></div> : <p className="pc-none">没有要看的体检提示。</p>}
                {digest.merged > 0 && <details className="sc-more"><summary>已合并 {digest.merged} 条（和正本 h3q / 卡片重复）</summary><ul className="sc-health">{flat.flatMap((card) => (card.health?.merged ?? []).map((entry, i) => <li key={`${card.key}-${i}`}>{splitTitle(card.shot.title, card.index).code}：{entry.message} → 见{entry.into}</li>))}</ul></details>}
              </div></> }; })(),
          ...(locked ? [{ id: "locked", label: submitted && !busyLock ? "已入队过" : "暂时不能改", tone: "warn" as const, summary: submitted && !busyLock ? "改了再入队会整批重渲；要改先另存成新队列" : locked,
            content: <div className="sc-bulk"><span>{locked}。</span>{submitted && !busyLock && <button type="button" className="sc-btn" onClick={saveAsNew}>另存成新队列（删掉不用重渲的镜头再入队）</button>}{saveNote && <em>{saveNote}</em>}</div> }] : []),
          ...(catalog ? [(() => { const summaryRows = flat.map((card) => ({ key: card.key, code: splitTitle(card.shot.title, card.index).code, title: card.shot.title, results: completeness.get(card.key) ?? [] })); const digest = completenessDigest(summaryRows, h3q.version, (row) => flat.some((card) => card.key === row.key && gateConfirm.lookup(card.shot)), (row) => flat.some((card) => card.key === row.key && (card.gate?.failing.length ?? 0) > 0));
            return { id: "completeness", label: "提示词完整度", tone: digest.tone, summary: digest.text, content: <><div className="sca-row"><AiCopyButton title="把漏写的镜头（每个类别附正本「怎样才算写到」）连同正本 h3q、画面五项复制成一段中文，贴给 AI 改" onCopy={() => copyForAi("提示词完整度有漏写的镜头", flat.filter((card) => (completeness.get(card.key) ?? []).some((result) => result.state === "missing")))} /></div><CompletenessDetail rows={summaryRows} jump={jump} currentVersion={h3q.version} /></> }; })()] : []),
          (() => { const digest = episodeFoldSummary(queue); return { id: "episode", label: "本集设定", tone: digest.tone, summary: digest.text, content: <EpisodePanel queue={queue} locked={locked} onChange={onChange} onLoad={onLoad} /> }; })(),
          ...(catalog ? (() => { const codes = flat.map((card) => ({ key: card.key, title: card.shot.title, code: splitTitle(card.shot.title, card.index).code })); const digest = reviewDigest(queue, reviewBook, codes.map((item) => item.title));
            return digest.show ? [{ id: "review", label: "审片", tone: digest.tone, summary: digest.summary, content: <ReviewDetail queue={queue} book={reviewBook} codes={codes} jump={jump} locked={busyLock} loadQueue={onLoad} /> }] : []; })() : []),
        ]} />
        <ReworkNoteBar queueTitle={queue.title} />
        {(musicCards.length > 1 || bulkError) && !locked && <div className="sc-bulk"><span>{musicCards.length} 镜正文写了「没有背景音乐」，队列已经禁了背景音乐，点名反而容易配乐。</span><button type="button" className="sc-btn" onClick={fixAllMusic}>全部删掉这句</button>{bulkError && <em>{bulkError}</em>}</div>}
        {filter === "duration" && <div className="sc-bulk"><span>只看正本 h3q 说时长可能不合适的 {durationCards.length} 镜（偏长 {durationCards.filter((card) => card.durationAdvice?.kind === "long").length}、偏短 {durationCards.filter((card) => card.durationAdvice?.kind === "short").length}）。只提醒，不拦截入队。</span>{!locked && durationCards.some((card) => card.durationAdvice?.suggest && card.durationAdvice.suggest !== card.shot.seconds) && <button type="button" className="sc-btn" onClick={() => void fixAllDurations()}>全部改成建议秒数</button>}<button type="button" className="sc-btn" onClick={() => setFilter("all")}>看全部</button></div>}
        {cutNote && <div className={`sc-bulk ${cutFade ? "sc-fade" : ""}`}><span>{cutNote}</span></div>}
        {dupTitles.length > 0 && <div className="sc-bulk"><span>有镜头标题重复：「{dupTitles.join("」「")}」。视频、忽略记录和接帧都按标题对应，请改成不同的标题。</span></div>}
        {lostJobs.length > 0 && <div className="sc-bulk kf"><span>刷新或关闭页面前还有 {lostJobs.length} 张关键帧没出完，已经丢了：{[...new Set(lostJobs.map((job) => job.queueTitle === queue.title ? job.shotTitle : `${job.shotTitle}（${job.queueTitle}）`))].join("、")}。当时正在出的那张 ComfyUI 会跑完，但图不会回到卡片；需要的话再点「出关键帧」。</span><button type="button" className="sc-btn" onClick={dismissLostKeyframeJobs}>知道了</button></div>}
        {(kfShots.length > 0 || jobs.length > 0) && !locked && <div className="sc-bulk kf"><span>先出关键帧：{kfShots.length} 镜还没定首帧{kfTodo.length ? `，其中 ${kfTodo.length} 镜还没出过图` : ""}。{jobs.length ? ` 当前 ${jobs.filter((job) => job.state !== "failed").length} 张排队/生成中。` : ""}</span>{kfTodo.length > 0 && <button type="button" className="sc-btn" onClick={runAllKeyframes} title={ESTIMATE_NOTE}>全部出关键帧（{kfTodo.length} 镜，{formatEstimate(keyframeEstimate(kfTodo.flatMap((card) => card.shot.keyframe ? [{ keyframe: card.shot.keyframe }] : []), queue.defaults?.keyframe))}，估算）</button>}{jobs.some((job) => job.state !== "running") && <button type="button" className="sc-btn" onClick={() => clearKeyframeJobs(true)}>取消排队 / 清掉失败</button>}</div>}
        {catalog && errorCards.length > 0 && <nav className="sc-jump"><span>先改这些</span>{errorCards.slice(0, 16).map((card) => <button type="button" key={card.key} title={card.checks.filter((check) => check.level === "error").map((check) => check.message).join("\n")} onClick={() => jump(card.key)}>{splitTitle(card.shot.title, card.index).code}</button>)}{errorCards.length > 16 && <em>等 {errorCards.length} 镜</em>}
          {Object.keys(overrides).length > 0 && <button type="button" className="sc-reset" onClick={() => { setOverrides({}); writeOverrides({}); }}>清除手动挪动 {Object.keys(overrides).length}</button>}
        </nav>}
      </div>
      <div className="sc-legend"><span>镜头</span><span>参考图</span>{kfInUse && <span>关键帧</span>}<span>参数</span><span>剧情</span><span>视频</span></div>
      {error ? <p className="sc-empty stop">{error}</p> : !catalog ? <p className="sc-empty">正在读取角色和素材…</p> : queue.chapters.map((chapter, c) => {
        const rows = cards[c].filter(visible);
        if (!rows.length) return null;
        return <section key={c} className="sc-chapter">
          <h3><span>{String(c + 1).padStart(2, "0")}</span>{chapter.title}<small>{chapter.shots.length} 镜</small>{queueDrawer?.enqueue && <button type="button" className="sc-btn sc-chapter-go" disabled={queueDrawer.enqueue.disabled || queueDrawer.enqueue.chapterBusy} title={queueDrawer.enqueue.chapterBusy ? "正在排队或在等你确认：先看「JSON / 进度」" : "本章入队／继续未完成：和「JSON / 进度」里每章的按钮一样，入队前会先在页面里问你"} onClick={() => queueDrawer.enqueue!.chapter(c)}>本章入队</button>}</h3>
          {rows.map((card, i) => <ShotRow showKf={kfInUse} ctx={ctxFor(card)} key={card.shot.title} card={card} delay={i} video={videos.get(card.shot.title) ?? null} render={renders.get(card.shot.title)} status={statuses[card.key]} onMove={move} ignored={new Set(ignores[ignoreKey(card)] ?? [])} onIgnore={(code, ignore) => setIgnore(card, code, ignore)} completeness={completeness.get(card.key)} />).flatMap((row, i) => [row, <ExperimentCompare key={`ab-${rows[i].shot.title}`} queue={queue} titleB={rows[i].shot.title} book={reviewBook} videos={(title) => (videos.get(title)?.versions ?? []).map((item) => ({ assetId: item.assetId, label: item.reviewLabel, source: item.asset.storageReference, zhengben: item.zhengben, stale: item.stale }))} />])}
        </section>;
      })}
      {catalog && filter !== "all" && !flat.some(visible) && <p className="sc-empty">没有这一类镜头</p>}
    </div>
    {experimentFor && <ExperimentDialog queue={queue} title={experimentFor.shot.title} submitted={submitted} locked={() => busyNow.current} onChange={onChange} onLoad={onLoad} onClose={() => setExperimentFor(null)} onDone={(message, titleB, where) => { setExperimentFor(null); setCutNote(message); if (where === "insert") { setFilter("all"); requestAnimationFrame(() => body.current?.querySelector(`[data-title="${CSS.escape(titleB)}"]`)?.scrollIntoView({ behavior: "smooth", block: "center" })); } }} />}
    {viewing && <ShotVideoViewer aside={(key) => { const card = flat.find((item) => item.key === key); return card && !card.pictures.length && !card.refError && !card.refProblems.length ? <T2vBlock rows={t2vDescription(card.shot, completeness.get(card.key))} full /> : null; }} start={viewing} onClose={() => setViewing("")} onLocate={jump} demix={(item, entry, show) => { const v = videos.get(entry.title); const version = v?.versions.find((x) => x.assetId === item.assetId); return v && version ? <DemixCardControl compact asset={version.asset} nodeId={version.nodeId} versions={v.versions.map((x) => x.asset)} row={demixRow} showHint="只是在这里看，不改「已采用」" onShow={show} /> : null; }} shots={flat.map((card) => { const v = videos.get(card.shot.title); const { code, name } = splitTitle(card.shot.title, card.index); return { key: card.key, title: card.shot.title, code, name, aspect: card.shot.aspect, chosenId: v?.chosen?.assetId ?? null, versions: (v?.versions ?? []).map((item) => ({ assetId: item.assetId, label: item.label, letter: item.letter, owner: item.owner, stale: item.stale, adopted: item.adopted, demixPasses: musicRemovalPassesOf(item.asset), sourceVideoAssetId: item.asset.sourceVideoAssetId, source: item.asset.storageReference })) }; })} />}
    {aiCopy.dialog}
    {viewingRef && (() => { const card = flat.find((item) => item.key === viewingRef.key); if (!card) return null; const { code, name } = splitTitle(card.shot.title, card.index);
      return <RefImageViewer start={viewingRef.tag} shotLabel={`镜头 ${code} · ${name}`} onClose={() => setViewingRef(null)} pictures={card.pictures.map((picture) => ({ tag: picture.label.replace("Picture ", "P"), group: /^(角色|场景|首帧|尾帧) /.exec(picture.name)?.[1] ?? "场景", name: picture.name.replace(/^(角色|场景|首帧|尾帧) /, ""), src: picture.src, roleId: picture.roleId, assetId: picture.assetId }))} />; })()}
    {cutting && <RoughCutDialog list={cutting.list} rows={cutting.rows} autoStart onClose={() => setCutting(null)} onReady={() => setCutNote("粗剪已生成，存在素材库里（素材 → 视频），对话框里可以直接下载")} />}
  </div>, document.body);
}

const STYLE = `
/* Colours come from app/tokens.css; these are the card board's local names for them. */
.sc-root{--ink:var(--ff-bg);--bay:var(--ff-bg);--panel:var(--ff-surface);--panel-2:var(--ff-raised);--cellbg:var(--ff-surface);--line:var(--ff-border-soft);--line-2:var(--ff-border-strong);--paper:var(--ff-text);--muted:var(--ff-text-2);--dim:var(--ff-text-3);
  --amber:var(--ff-white);--amber-deep:var(--ff-white);--amber-glow:var(--ff-accent-soft);--warn:var(--ff-warn);--go:var(--ff-ok);--stop:var(--ff-bad);--cold:var(--ff-queue);
  --display:var(--sans);--sans:var(--ff-font);--mono:var(--ff-mono);
  position:fixed;inset:0;z-index:10000;display:flex;flex-direction:column;color:var(--paper);font:13px/1.6 var(--sans);-webkit-font-smoothing:antialiased;pointer-events:auto;
  background:var(--bay)}
.sc-root button{font:inherit;color:inherit;cursor:pointer}
.sc-root :focus-visible{outline:2px solid var(--amber);outline-offset:2px}
.sc-root .muted{color:var(--dim)}.sc-root .dim{color:var(--dim)}

/* header + strip, same language as 生产线 */
.sc-slate-head{position:relative;display:flex;align-items:flex-end;justify-content:space-between;gap:16px;padding:22px 32px 18px;border-bottom:1px solid var(--line)}
.sc-title{min-width:0}
.sc-kicker{font:12px var(--mono);letter-spacing:.2em;color:var(--dim)}
.sc-title h2{margin:4px 0 0;font:600 24px/1.3 var(--display);letter-spacing:.01em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.sc-close{flex:none;width:38px;height:38px;display:grid;place-items:center;border:1px solid var(--line-2);border-radius:10px;background:var(--panel);color:var(--muted)}
.sc-close:hover{color:var(--paper);border-color:var(--muted)}
.sc-strip{display:grid;grid-template-columns:repeat(6,1fr);margin:16px 32px 0;border:1px solid var(--line);border-radius:10px;overflow:hidden;background:var(--panel)}
.sc-strip>*{position:relative;padding:11px 14px;border:0;border-right:1px solid var(--line);background:transparent;text-align:left}
.sc-strip>*:last-child{border-right:0}
.sc-strip b{display:block;font:600 22px/1 var(--mono);color:var(--paper)}
.sc-strip span{display:block;margin-top:6px;font-size:12px;color:var(--muted)}
.sc-strip .hot-bad b{color:var(--stop)}.sc-strip .hot-warn b{color:var(--warn)}.sc-strip .hot-ok b{color:var(--go)}
.sc-strip b.g{color:var(--go)}.sc-strip b.w{color:var(--warn)}
.sc-strip button:hover{background:var(--panel-2)}
.sc-strip button.on{background:var(--panel-2);box-shadow:inset 0 -2px 0 currentColor}
.sc-strip>.sc-stat{display:flex;align-items:center;gap:8px;padding:0}
.sc-stat-main{flex:1;align-self:stretch;padding:11px 14px;border:0;background:transparent;text-align:left;cursor:pointer}
.sc-stat-main:hover{background:var(--panel-2)}
.sc-stat.on{background:var(--panel-2);box-shadow:inset 0 -2px 0 currentColor}.sc-stat.hot-bad.on{color:var(--stop)}.sc-stat.hot-warn.on{color:var(--warn)}
.sc-copy{flex:none;margin-right:12px;padding:5px 11px;border:1px solid currentColor;border-radius:999px;background:transparent;font-size:12px;white-space:nowrap;opacity:.85;transition:background .15s,opacity .15s}
.hot-bad .sc-copy{color:var(--stop)}.hot-warn .sc-copy{color:var(--warn)}
.sc-copy:hover{opacity:1;background:rgba(255,255,255,.06)}
.sc-strip .hot-bad.on{color:var(--stop)}.sc-strip .hot-warn.on{color:var(--warn)}
.sc-jump{display:flex;flex-wrap:wrap;align-items:center;gap:6px;margin:12px 32px 0;padding:9px 12px;border:1px solid rgba(220,138,124,.4);border-radius:10px;background:rgba(220,138,124,.07)}
.sc-jump>span{font-size:12px;color:var(--stop);margin-right:4px}
.sc-jump button{padding:2px 9px;border:1px solid rgba(220,138,124,.45);border-radius:999px;background:transparent;font:12px var(--mono);color:var(--stop)}
.sc-jump button:hover{background:rgba(220,138,124,.15)}
.sc-jump em{font-style:normal;font-size:12px;color:var(--muted)}
.sc-jump .sc-reset{margin-left:auto;border-color:var(--line-2);color:var(--muted);font-family:var(--sans)}

/* reel: one horizontal row per shot — 镜头 | 参考图 | 参数格子 | 剧情 | 视频 */
.sc-reel{flex:1;overflow:auto;padding:4px 32px 60px}
.sc-legend,.sc-row{display:grid;grid-template-columns:118px auto 150px 300px minmax(280px,1fr) 156px;column-gap:18px}
.sc-legend{position:sticky;top:0;z-index:5;padding:16px 18px 8px;font:12px var(--mono);letter-spacing:.16em;color:var(--dim);background:linear-gradient(var(--bay) 72%,transparent)}
.sc-legend span:nth-child(2){min-width:120px}
.sc-chapter h3{display:flex;align-items:baseline;gap:10px;margin:14px 0 10px;font:600 16px var(--display);letter-spacing:.01em}
.sc-chapter h3 span{font:600 12px var(--mono);color:var(--amber);letter-spacing:.1em}
.sc-chapter h3 small{font:12px var(--mono);color:var(--dim)}
.sc-row{position:relative;align-items:start;row-gap:14px;padding:16px 18px;margin-bottom:12px;border:1px solid var(--line);border-radius:14px;background:linear-gradient(180deg,var(--panel),var(--ink));scroll-margin-top:44px;animation:sc-rise .4s both}
@keyframes sc-rise{from{opacity:0;transform:translateY(8px)}}
.sc-row::before{content:"";position:absolute;left:-1px;top:14px;bottom:14px;width:3px;border-radius:2px;background:var(--go)}
.sc-row.warn::before{background:var(--warn)}.sc-row.bad::before{background:var(--stop)}
.sc-row.bad{border-color:rgba(220,138,124,.18)}
/* 画面五项人工放行的镜头：整张卡灰色标记（左边灰条 + 虚线边），一眼能和正常写全的分开 */
.sc-row.gate-confirmed:not(.bad){border-style:dashed;border-color:var(--ff-border-strong)}.sc-row.gate-confirmed:not(.bad)::before{background:var(--ff-text-4)}
.sc-row>*{min-width:0}

.sc-slate{display:flex;flex-direction:column;align-items:flex-start;gap:7px}
.sc-code{font:600 30px/1 var(--mono);letter-spacing:-.02em}
.sc-name{font-size:12.5px;line-height:1.45;color:var(--muted)}
.sc-chip{display:inline-flex;padding:2px 9px;border-radius:999px;border:1px solid var(--line-2);color:var(--muted);font-size:12px;white-space:nowrap}
.sc-chip.cold{border-color:rgba(141,154,168,.5);color:var(--cold)}.sc-chip.go{border-color:rgba(143,184,156,.5);color:var(--go)}
.sc-chip.amber{border-color:rgba(214,189,132,.5);color:var(--warn)}.sc-chip.stop{border-color:rgba(220,138,124,.55);color:var(--stop);background:rgba(220,138,124,.07)}
.sc-toggle{display:inline-flex;align-items:center;gap:4px;margin-top:4px;padding:0;border:0;background:none;color:var(--dim);font-size:12px}
.sc-toggle:hover{color:var(--amber)}

.sc-refs{display:flex;flex-direction:column;gap:8px;min-width:120px}
.sc-ref-group{display:flex;align-items:flex-start;gap:8px}.sc-ref-items{display:flex;flex-wrap:wrap;gap:8px;min-width:0}.sc-ref-items .sc-thumb{width:58px}
.sc-ref-head{flex:0 0 auto;width:28px;padding-top:2px;font-size:12px;color:var(--dim)}
.sc-ref-none{font-style:normal;font-size:12px;color:var(--ff-text-4);padding-top:2px}
.sc-thumb{margin:0;width:84px}
.sc-frame{position:relative;aspect-ratio:9/16;border-radius:8px;overflow:hidden;border:1px solid var(--line);background:var(--ink);display:grid;place-items:center;color:var(--dim)}
.sc-frame img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;transition:transform .25s}
.sc-thumb:hover .sc-frame img{transform:scale(1.04)}
.sc-frame i{position:absolute;left:4px;top:4px;padding:0 5px;border-radius:4px;background:rgba(12,12,12,.85);font:600 12px/16px var(--mono);font-style:normal;color:var(--amber)}
.sc-thumb figcaption{margin-top:4px;font-size:12px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.sc-ref-missing{width:84px;aspect-ratio:9/16;display:grid;place-items:center;padding:6px;border:1px dashed var(--line-2);border-radius:8px;color:var(--stop);font-size:12px;text-align:center}

.sc-cells{display:grid;grid-template-columns:1fr 1fr;gap:6px;align-content:start}
.sc-cell{display:flex;flex-direction:column;gap:2px;padding:6px 9px;border:1px solid var(--line);border-radius:8px;background:var(--cellbg);min-width:0}
.sc-cell.wide{grid-column:span 2}
.sc-cell>span{font:12px var(--mono);letter-spacing:.12em;color:var(--dim)}
.sc-cell>b{font:500 13px/1.45 var(--sans);color:var(--paper);overflow:hidden;text-overflow:ellipsis}
.sc-cell>b small{margin-left:2px;font:12px var(--mono);color:var(--dim)}
.sc-cell.stop{border-color:rgba(220,138,124,.5);background:rgba(220,138,124,.07)}.sc-cell.stop>b{color:var(--stop)}
.sc-cell.amber>b{color:var(--warn)}.sc-cell.go>b{color:var(--go)}.sc-cell.cold>b{color:var(--cold);font-size:12px}
.sc-role{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.sc-role button.lines{padding:0 6px;border-radius:5px;border:1px solid var(--line-2);background:transparent;font:normal 12px/17px var(--sans);color:var(--dim);cursor:pointer}.sc-role button.lines.on{color:var(--ink,inherit);border-color:var(--muted)}.sc-role button.lines:disabled{cursor:not-allowed;opacity:.5}
.sc-lines-edit textarea{width:100%;margin-top:6px}.sc-lines-actions{display:flex;gap:6px;margin-top:6px}.sc-lines-import{flex-wrap:wrap}.sc-lines-import textarea{flex:1 1 100%}
.sc-role i{padding:0 6px;border-radius:5px;border:1px solid var(--line-2);font:normal 12px/17px var(--sans);color:var(--dim)}
.sc-role i.go{border-color:rgba(143,184,156,.45);color:var(--go)}.sc-role i.stop{border-color:rgba(220,138,124,.55);color:var(--stop);background:rgba(220,138,124,.08)}
.sc-role em.stop{font-style:normal;color:var(--stop)}

.sc-story{padding:2px 0}
.sc-lede{margin:0 0 10px;font-size:15px;line-height:1.65;color:var(--paper)}
.sc-beats{list-style:none;margin:0;padding:0;border-left:1px dashed var(--line-2)}
.sc-beats li{position:relative;display:grid;grid-template-columns:64px 1fr;gap:8px;padding:3px 0 7px 12px}
.sc-beats li::before{content:"";position:absolute;left:-4px;top:10px;width:7px;height:7px;border-radius:50%;background:var(--bay);border:1px solid var(--amber)}
.sc-beats li.start::before{background:var(--amber)}
.sc-beats time{font:12px/22px var(--mono);color:var(--amber);white-space:nowrap}
.sc-beats li.start time{color:var(--muted)}
.sc-beats li>div{font-size:13.5px;line-height:1.7}
.sc-beat-cam{display:block;font-size:12px;color:var(--cold)}
.sc-beats q,.sc-dialogue q{display:block;margin:5px 0 2px;padding:5px 10px;border-radius:0 8px 8px 0;border-left:2px solid var(--amber);background:var(--amber-glow);color:var(--paper);font-size:13px;quotes:"“" "”"}
.sc-beats q em{font-style:normal;color:var(--amber);margin-right:6px;font-size:12px}
.sc-dialogue{margin-top:8px}
.sc-final{margin-right:4px;padding:0 5px;border-radius:4px;background:var(--panel-2);border:1px solid var(--line-2);color:var(--muted);font:500 12px/16px var(--sans)}
.sc-more{margin-top:10px;font-size:12px}
.sc-more summary{cursor:pointer;color:var(--dim);font:12px var(--mono);letter-spacing:.06em;list-style:none}
.sc-more summary::before{content:"▸ ";color:var(--amber)}.sc-more[open] summary::before{content:"▾ "}
.sc-more summary:hover{color:var(--paper)}
.sc-more>p{margin:6px 0 0;color:var(--muted);line-height:1.65}
.sc-more>p em{font-style:normal;margin-right:8px;font:12px var(--mono);color:var(--amber)}

.sc-video{position:relative;width:100%;border-radius:10px;overflow:hidden;border:1px solid var(--line);background:var(--ink)}
.sc-video.empty{display:grid;place-items:center;border-style:dashed;background:repeating-linear-gradient(-45deg,transparent 0 8px,rgba(255,255,255,.025) 8px 16px)}
.sc-video.empty span{color:var(--dim);font-size:12px}
.sc-video video{display:block;width:100%;height:100%;object-fit:cover;background:#000}
.sc-video>button{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:4px;border:0;background:var(--ink) center/cover no-repeat;color:var(--paper)}
.sc-video>button svg{padding:10px;width:40px;height:40px;border-radius:50%;background:rgba(12,12,12,.75);border:1px solid var(--amber);color:var(--amber)}
.sc-video>button span{font-size:12px;color:var(--muted)}
.sc-video>button:hover svg{background:var(--amber);color:var(--ff-ink)}
.sc-video i{position:absolute;left:6px;top:6px;padding:0 6px;border-radius:5px;background:rgba(12,12,12,.85);font:normal 12px/17px var(--sans);color:var(--amber);pointer-events:none}

.sc-checks{grid-column:2/-1;padding:9px 12px;border-radius:10px;border:1px solid var(--line)}
.sc-checks.bad{border-color:rgba(220,138,124,.4);background:rgba(220,138,124,.06)}
.sc-checks.warn{border-color:rgba(214,189,132,.32);background:rgba(214,189,132,.05)}
.sc-checks.ok{border-color:var(--line);background:transparent}
.sc-checks ul{list-style:none;margin:0;padding:0;display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:5px 18px}
.sc-checks li{position:relative;padding-left:14px;font-size:12.5px;line-height:1.55}
.sc-checks li::before{content:"";position:absolute;left:0;top:7px;width:6px;height:6px;border-radius:50%}
.sc-checks li.e{color:var(--stop)}.sc-checks li.e::before{background:var(--stop);box-shadow:0 0 8px rgba(220,138,124,.7)}
.sc-checks li.w{color:var(--paper)}.sc-checks li.w::before{background:var(--warn)}
.sc-checks li button,.sc-ignored button{margin-left:6px;padding:0 7px;border:1px solid var(--line-2);border-radius:999px;background:transparent;font-size:12px;line-height:16px;color:var(--dim);vertical-align:1px}
.sc-checks li button:hover,.sc-ignored button:hover{color:var(--paper);border-color:var(--muted)}
.sc-checks li.h{color:var(--muted)}.sc-checks li.h::before{background:var(--line-2)}
.sc-src{display:inline-block;margin-right:6px;padding:0 6px;border:1px solid var(--line-2);border-radius:4px;font:11px/16px var(--mono);color:var(--dim);vertical-align:1px}
.sc-src.h3q{border-color:var(--muted);color:var(--paper)}
.sc-h3q{background:transparent}.sc-h3q.fail{border-color:rgba(220,138,124,.55);color:var(--stop)}
.sc-h3q-legacy{flex-basis:100%;display:flex;gap:8px;align-items:baseline;padding:6px 10px;border-left:2px solid var(--ff-warn,#d6b25e);background:color-mix(in srgb,var(--ff-warn,#d6b25e) 8%,transparent);font-size:12.5px;line-height:1.55;color:var(--ff-text)}.sc-h3q-legacy b{flex:none;color:var(--ff-warn,#d6b25e);font-weight:600}
.sc-h3q-more{flex-basis:100%;display:flex;flex-wrap:wrap;align-items:flex-end;gap:8px}.sc-h3q-more label{flex:1;min-width:260px;display:flex;flex-direction:column;gap:4px;color:var(--dim)}
.sc-h3q-more small{flex-basis:100%;color:var(--dim)}.sc-h3q-more ul{flex-basis:100%;list-style:none;margin:0;padding:0;display:grid;gap:3px}
.sc-h3q-more li.e{color:var(--stop)}.sc-h3q-more li.w{color:var(--paper)}.sc-h3q-more li.h{color:var(--muted)}
.sc-zhengben{display:block;margin-top:4px;font:11px var(--mono);color:var(--dim)}
.sc-ignored{margin:6px 0 0;font-size:12px;color:var(--dim)}
.sc-health{display:block!important}.sc-health li{padding-left:0!important;color:var(--muted)!important;font-size:12px!important}.sc-health li::before{display:none}

.sc-clause-text{all:unset;cursor:pointer;border-radius:3px;transition:background .12s}
.sc-clause-text:hover{background:rgba(255,255,255,.07);box-shadow:0 1px 0 rgba(255,255,255,.36)}
.sc-move{display:inline-flex;gap:3px;margin:0 4px;padding:1px 5px;border-radius:6px;border:1px solid var(--line-2);background:var(--ink);font-size:12px;color:var(--dim);vertical-align:1px}
.sc-move button{padding:0 6px;border:0;border-radius:4px;background:var(--panel-2);font-size:12px;color:var(--paper)}
.sc-move button:hover{background:var(--amber);color:var(--ff-ink)}
.sc-prompt{grid-column:1/-1;margin:0;padding:14px 16px;max-height:340px;overflow:auto;white-space:pre-wrap;border-radius:10px;border:1px solid var(--line);background:var(--ink);color:var(--muted);font:12px/1.7 var(--mono)}
.sc-empty{padding:40px 0;text-align:center;color:var(--dim)}.sc-empty.stop{color:var(--stop)}
.sc-head-actions{display:flex;align-items:center;gap:10px}
.sc-video-wrap{display:flex;flex-direction:column;gap:6px;min-width:0}
.sc-versions{display:flex;flex-wrap:wrap;gap:4px}
.sc-versions button{min-width:28px;padding:2px 8px;border:1px solid var(--line-2);border-radius:6px;background:var(--panel-2);font:600 12px var(--mono);color:var(--muted)}
.sc-versions button:hover:not(.on){color:var(--paper);border-color:var(--muted)}
.sc-versions button.on{background:var(--amber);border-color:var(--amber);color:var(--ff-ink)}
.sc-versions button.stale{text-decoration:line-through;opacity:.7}
.sc-video.stale{outline:2px dashed rgba(255,255,255,.36);outline-offset:-2px}
.sc-render-btn{margin-top:4px;padding:5px 12px;font-size:12px;background:var(--amber);border-color:var(--amber-deep);color:var(--ff-ink);font-weight:700}
.sc-render-btn:disabled{background:var(--panel-2);border-color:var(--line-2);color:var(--dim);font-weight:400}
.sc-kf{display:flex;flex-direction:column;gap:6px;min-width:0}
.sc-kf-add{width:100%;aspect-ratio:9/16;max-height:200px;border:1px dashed var(--line-2);border-radius:8px;background:transparent;color:var(--dim);font-size:12px}
.sc-kf-add:hover:not(:disabled){border-color:var(--amber);color:var(--amber);background:var(--amber-glow)}
.sc-kf-chain{padding:10px;border:1px dashed rgba(141,154,168,.45);border-radius:8px;color:var(--cold);font-size:12px;line-height:1.6;text-align:center}
.sc-kf-chain b{color:var(--paper);font-weight:500;word-break:break-all}
.sc-kf-main{margin:0}.sc-kf-main .sc-frame{border-color:var(--amber);box-shadow:0 0 0 2px var(--amber),0 0 18px var(--amber-glow)}
.sc-kf-cands{display:grid;grid-template-columns:repeat(2,1fr);gap:6px}
.sc-kf-cands figure{margin:0}.sc-kf-cands figure.rejected .sc-frame{filter:grayscale(1) brightness(.45)}
.sc-kf-acts{display:flex;gap:3px;margin-top:3px}
.sc-kf-acts button,.sc-kf-mini{flex:1;padding:2px 0;border:1px solid var(--line-2);border-radius:5px;background:var(--panel-2);font-size:12px;color:var(--muted)}
.sc-kf-acts button.ok{border-color:rgba(255,255,255,.36);color:var(--amber)}.sc-kf-acts button.ok:hover{background:var(--amber);color:var(--ff-ink)}
.sc-kf-mini{width:100%;margin-top:4px}
.sc-kf-go{padding:5px 0;border:1px solid rgba(255,255,255,.33);border-radius:7px;background:transparent;font-size:12px;color:var(--amber)}
.sc-kf-go:hover:not(:disabled){background:var(--amber);color:var(--ff-ink)}.sc-kf-go:disabled,.sc-kf-add:disabled{opacity:.4;cursor:not-allowed}
.sc-kf-run{margin:0;font-size:12px;color:var(--cold)}.sc-kf-fail{margin:0;font-size:12px;color:var(--stop);word-break:break-all}
.sc-bulk.kf{border-color:rgba(141,154,168,.4);background:rgba(141,154,168,.07);color:var(--cold)}
.sc-edit-kf{display:grid;gap:8px}.sc-edit-kf>label{display:flex;flex-direction:column;gap:3px}.sc-edit-kf>label>span{font:12px var(--mono);letter-spacing:.06em;color:var(--dim)}
.sc-check-line{flex-direction:row!important;align-items:center;gap:6px!important;font-size:12.5px;color:var(--paper);cursor:pointer}
.sc-row-tools{display:flex;gap:4px;margin-top:2px}
.sc-row-tools button{min-width:28px;padding:3px 7px;border:1px solid var(--line-2);border-radius:6px;background:var(--panel-2);font-size:12px;color:var(--muted);transition:color .15s,border-color .15s}
.sc-row-tools button:hover:not(:disabled){color:var(--amber);border-color:var(--amber)}
.sc-row-tools button.del:hover:not(:disabled){color:var(--stop);border-color:var(--stop)}
.sc-row-tools button:disabled{opacity:.35;cursor:not-allowed}
.sc-seg-switch{display:grid;grid-template-columns:1fr 1fr;gap:3px;margin-top:4px;padding:3px;border-radius:8px;background:var(--ink);border:1px solid var(--line)}
.sc-seg-switch button{padding:4px 0;border:0;border-radius:6px;background:transparent;font-size:12.5px;color:var(--muted);transition:background .15s,color .15s}
.sc-seg-switch button:hover:not(:disabled):not(.on){color:var(--paper);background:var(--panel-2)}
.sc-seg-switch button.on{background:var(--amber);color:var(--ff-ink);font-weight:700}
.sc-seg-switch button.on.u{background:linear-gradient(180deg,var(--cold),var(--cold));color:rgba(141,154,168,.15)}
.sc-seg-switch button:disabled:not(.on){opacity:.4;cursor:not-allowed}
.sc-sec{display:inline-flex;align-items:center;gap:4px}.sc-sec-step{display:inline-flex;flex-direction:column;margin-left:4px}
.sc-sec-step button{width:18px;height:12px;padding:0;display:grid;place-items:center;border:1px solid var(--line-2);background:var(--panel);color:var(--muted);font-size:8px;line-height:1}
.sc-sec-step button:first-child{border-radius:4px 4px 0 0;border-bottom:0}.sc-sec-step button:last-child{border-radius:0 0 4px 4px}
.sc-sec-step button:hover:not(:disabled){color:var(--paper);border-color:var(--muted)}.sc-sec-step button:disabled{opacity:.35;cursor:not-allowed}
.sc-checks{position:relative}.sc-checks-copy{float:right;margin:0 0 6px 10px;padding:3px 10px;font-size:12px;gap:5px}.sc-checks-copy svg{width:13px;height:13px}
.sc-ref-why{white-space:normal;text-align:left;line-height:1.5;padding:6px 8px}.sc-ref-why em{font-style:normal;color:var(--paper);margin-left:2px}
.sc-t2v{align-self:start;max-width:100%;padding:8px 10px;border:1px dashed var(--line-2);border-radius:8px;color:var(--muted);font-size:12px;line-height:1.5;background:transparent}
.sc-t2v-head{display:block;margin-bottom:4px;font-weight:600;color:var(--muted)}
.sc-t2v ul{margin:0;padding:0;list-style:none;display:grid;gap:2px}.sc-t2v li{display:grid;grid-template-columns:30px minmax(0,1fr);gap:6px}
.sc-t2v li i{font-style:normal;color:var(--dim)}.sc-t2v li .none{color:var(--dim)}
.sc-t2v.clip ul{max-height:9em;overflow:hidden;-webkit-mask-image:linear-gradient(#000 70%,transparent)}
.sc-t2v-more{margin-top:4px;padding:0;border:0;background:none;color:var(--muted);font-size:12px;text-decoration:underline}.sc-t2v-more:hover{color:var(--paper)}
.sc-t2v-note{display:block;margin-top:6px;color:var(--dim)}
.sc-health-merged{margin:6px 0 0;font-size:12px;color:var(--dim)}
.sc-mp{display:inline-flex;align-items:center;gap:4px;flex-wrap:wrap}
.sc-mp button{padding:1px 7px;border:1px solid var(--line);border-radius:6px;background:transparent;color:var(--dim);font:500 12px/1.5 var(--mono)}
.sc-mp button small{margin-left:3px;font:11px var(--sans);color:var(--dim)}
.sc-mp button.on,.scf-mp button.on{border-color:var(--ff-text-2);background:var(--ff-hover);color:var(--paper);font-weight:600}.sc-mp button.on small{color:var(--muted)}
.sc-mp button:hover:not(:disabled):not(.on){border-color:var(--muted);color:var(--paper)}.sc-mp button:disabled{opacity:.45;cursor:not-allowed}
.sc-mp em{font:normal 11px var(--sans);color:var(--dim)}
.sc-duration>b{font-weight:400;font-size:12px;color:var(--muted);white-space:normal}
.sc-duration-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:4px}.sc-duration-actions .sc-btn{padding:3px 10px;font-size:12px}
.scf-mp{display:inline-flex;align-items:center;gap:3px}.scf-mp button{padding:0 5px;border:1px solid var(--line);border-radius:5px;background:transparent;color:var(--dim);font:11px var(--mono)}.scf-mp em{font:normal 11px var(--sans);color:var(--dim);margin-left:2px}
.sc-bulk.sc-fade{opacity:0;transition:opacity .6s}
.scf-mp button:hover:not(:disabled):not(.on){color:var(--paper);border-color:var(--muted)}.scf-mp button:disabled{opacity:.4;cursor:not-allowed}
.sc-bulk{display:flex;flex-wrap:wrap;align-items:center;gap:10px;margin:12px 32px 0;padding:9px 12px;border:1px solid rgba(255,255,255,.24);border-radius:10px;background:var(--amber-glow);font-size:12.5px;color:var(--paper)}
.sc-bulk em{font-style:normal;color:var(--stop)}
.sc-btn:disabled{opacity:.45;cursor:not-allowed}
.sc-edit-btn{margin-top:4px;padding:5px 12px;font-size:12px;border-color:rgba(255,255,255,.33);color:var(--amber)}
.sc-checks li button.fix{border-color:rgba(255,255,255,.36);color:var(--amber)}
.sc-checks li button.fix:hover{background:var(--amber);color:var(--ff-ink)}
.sc-beats q,.sc-dialogue q{quotes:none}
.sc-row.editing{grid-template-columns:118px minmax(0,1fr);border-color:rgba(255,255,255,.27);box-shadow:0 0 0 1px rgba(255,255,255,.09),0 18px 40px rgba(0,0,0,.35)}
.sc-row.editing::before{background:var(--amber)}
.sc-editor{display:grid;grid-template-columns:minmax(300px,380px) minmax(0,1fr);gap:22px;min-width:0}
.sc-editor h5{margin:0 0 8px;font:12px var(--mono);letter-spacing:.14em;color:var(--dim)}
.sc-editor h5:not(:first-child){margin-top:16px}
.sc-input{width:100%;box-sizing:border-box;padding:7px 10px;border:1px solid var(--line-2);border-radius:8px;background:var(--ink);color:var(--paper);font:13px/1.6 var(--sans);outline:none;transition:border-color .15s}
.sc-input:focus{border-color:var(--amber)}
textarea.sc-input{resize:vertical;overflow:hidden;min-height:34px}
select.sc-input{cursor:pointer}
.sc-edit-thumbs{display:flex;flex-wrap:wrap;gap:8px}
.sc-edit-thumb .sc-thumb{width:72px}
.sc-mini-row{display:flex;gap:4px;margin-top:3px}
.sc-mini-row button{flex:1;padding:1px 0;border:1px solid var(--line-2);border-radius:5px;background:var(--panel-2);font-size:12px;color:var(--muted)}
.sc-mini-row button:hover{color:var(--stop);border-color:var(--stop)}
.sc-add-thumb{width:72px;aspect-ratio:9/16;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:4px;border:1px dashed var(--line-2);border-radius:8px;background:transparent;color:var(--amber);font-size:20px}
.sc-add-thumb span{font-size:12px;color:var(--muted)}
.sc-add-thumb:hover{border-color:var(--amber);background:var(--amber-glow)}
.sc-picker{margin-top:10px;padding:10px;border:1px solid var(--line-2);border-radius:10px;background:var(--ink)}
.sc-picker-head{display:flex;gap:8px;margin-bottom:8px}
.sc-picker-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(64px,1fr));gap:6px;max-height:260px;overflow:auto}
.sc-picker-grid button{padding:0;border:0;background:none;text-align:left}
.sc-picker-grid .sc-thumb{width:100%}
.sc-picker-grid button:hover .sc-frame{border-color:var(--amber)}
.sc-edit-roles{display:flex;flex-wrap:wrap;gap:6px;align-items:center}
.sc-edit-roles select{width:auto;flex:1;min-width:120px}
.sc-role-chip{display:inline-flex;align-items:center;gap:8px;padding:4px 6px 4px 10px;border:1px solid var(--line-2);border-radius:999px;background:var(--panel-2);font-size:12.5px}
.sc-role-chip label{display:inline-flex;align-items:center;gap:3px;font-size:12px;color:var(--muted);cursor:pointer}
.sc-role-chip button{width:20px;height:20px;padding:0;border:0;border-radius:50%;background:transparent;color:var(--dim)}
.sc-role-chip button:hover{background:rgba(220,138,124,.2);color:var(--stop)}
.sc-edit-params{display:grid;grid-template-columns:1fr 1fr;gap:8px}
.sc-edit-params label{display:flex;flex-direction:column;gap:3px}
.sc-edit-params label>span{font:12px var(--mono);letter-spacing:.1em;color:var(--dim)}
.sc-edit-segments{display:grid;gap:6px}
.sc-seg{display:grid;grid-template-columns:72px minmax(0,1fr);gap:10px;align-items:start}
.sc-seg>span{padding-top:8px;font:12px var(--mono);color:var(--amber);text-align:right;white-space:nowrap}
.sc-seg.dirty textarea{border-color:rgba(255,255,255,.42);background:var(--ink)}
.sc-edit-lines{display:grid;gap:6px}
.sc-edit-line{display:grid;grid-template-columns:120px minmax(0,1fr) auto;gap:6px}
.sc-edit-lines>.sc-btn{justify-self:start}
.sc-edit-actions{position:sticky;bottom:-60px;display:flex;align-items:center;justify-content:flex-end;gap:10px;margin-top:16px;padding:10px 0 0;border-top:1px solid var(--line);background:linear-gradient(transparent,var(--ink) 30%)}
.sc-edit-actions .muted{margin-right:auto;font-size:12px}
@media (max-width:1080px){.sc-editor{grid-template-columns:1fr}}

.sc-btn{display:inline-flex;align-items:center;gap:6px;padding:8px 14px;border:1px solid var(--line-2);border-radius:8px;background:var(--panel);font-size:13px;color:var(--paper);cursor:pointer;transition:background .15s,border-color .15s}
.sc-btn:hover{border-color:var(--muted);background:var(--panel-2)}
.sc-btn.primary{background:var(--amber);border-color:var(--amber-deep);color:var(--ff-ink);font-weight:700}
.sc-btn.primary:hover{filter:brightness(1.07)}
.sc-btn.on{border-color:var(--muted);background:var(--panel-2)}
.sc-empty-guide{max-width:520px;margin:56px calc(min(560px,100vw) + 32px) 0 48px;color:var(--muted);line-height:1.8}
.sc-empty-guide b{color:var(--paper)}.sc-empty-guide p{margin:0 0 10px}.sc-empty-guide code{font-family:var(--mono)}
@media (max-width:900px){.sc-empty-guide{display:none}}
.sc-btn small{font:12px var(--mono);opacity:.65}
.sc-intake{flex:1;display:flex;flex-direction:column;gap:12px;margin:20px 32px 32px;padding:20px;border:1px dashed var(--line-2);border-radius:14px;background:linear-gradient(180deg,var(--panel),var(--ink));min-height:0;transition:border-color .15s,background .15s}
.sc-intake.drag{border-color:var(--amber);background:var(--amber-glow)}
.sc-intake-hint{margin:0;color:var(--muted)}.sc-intake-hint code{font:12px var(--mono);color:var(--amber)}
.sc-intake textarea{flex:1;min-height:240px;resize:none;padding:14px 16px;border:1px solid var(--line);border-radius:10px;background:var(--ink);color:var(--paper);font:12.5px/1.65 var(--mono);outline:none}
.sc-intake textarea:focus{border-color:var(--amber)}
.sc-intake-error{margin:0;padding:8px 12px;border-radius:8px;border:1px solid rgba(220,138,124,.45);background:rgba(220,138,124,.08);color:var(--stop);white-space:pre-wrap;font-size:12.5px}
.sc-intake-actions{display:flex;justify-content:flex-end;gap:10px}
.sc-path{position:relative;flex:1 1 260px;min-width:0;margin-right:auto;display:flex}
.sc-path>.sc-input{height:100%;padding:0 12px;font:12.5px var(--mono)}
.sc-path>.sc-input::placeholder{color:var(--dim)}
.sc-path-recent{position:absolute;left:0;right:0;bottom:calc(100% + 4px);margin:0;padding:4px;list-style:none;border:1px solid var(--line-2);border-radius:8px;background:var(--panel);box-shadow:0 10px 28px rgba(0,0,0,.45);z-index:5}
.sc-path-recent-head{padding:4px 8px 2px;font-size:11.5px;color:var(--dim)}
.sc-path-recent button{display:block;width:100%;padding:6px 8px;border:0;border-radius:6px;background:none;color:var(--paper);font:12px var(--mono);text-align:left;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;cursor:pointer}
.sc-path-recent button:hover{background:var(--line)}

@media (max-width:1400px){.sc-legend,.sc-row{grid-template-columns:104px auto 128px 260px minmax(240px,1fr) 128px;column-gap:14px}.sc-thumb,.sc-ref-missing{width:70px}}
@media (max-width:1080px){.sc-legend{display:none}.sc-row{grid-template-columns:104px minmax(0,1fr) 128px}.sc-refs{grid-column:2}.sc-cells{grid-column:2}.sc-story{grid-column:2}.sc-video{grid-column:3;grid-row:1/span 3}.sc-checks{grid-column:1/-1}
  .sc-strip{grid-template-columns:repeat(3,1fr)}.sc-slate-head,.sc-strip,.sc-jump{margin-left:16px;margin-right:16px}.sc-reel{padding:4px 16px 40px}}
`;
