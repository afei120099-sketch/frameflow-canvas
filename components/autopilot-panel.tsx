"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Circle, CircleAlert, CircleCheck, CircleX, Clapperboard, Copy, Download, FolderSearch, LoaderCircle, Moon, Play, RotateCcw, Square, Upload, X } from "lucide-react";
import {
  AUTOPILOT_FAILURE_LABELS, AUTOPILOT_M1_SETTINGS, AUTOPILOT_M1_SHOTS, AUTOPILOT_M2_KIND, AUTOPILOT_STATUS_LABELS, ROUGH_CUT_STATUS_LABELS, RUNNING_AUTOPILOT_STATUSES, SHOT_STATUS_LABELS, isActiveAutopilotJob,
  type AutopilotJob, type ProductionGateCheck, type ShotTask,
} from "@/lib/autopilot";
import {
  M2_ASPECTS, M2_DEFAULT_ASPECT, M2_DEFAULT_PRESET, M2_DEFAULT_SECONDS, M2_INTENT_MAX, M2_PRESET_IDS, M2_PRESETS, M2_SECONDS_RANGE, PRODUCT_FACTS_REQUIRED_MESSAGE, suggestPreset,
  type DirectorConstraints, type M2Aspect, type M2PresetId, type PlanCheck,
} from "@/lib/autopilot-director";
import { AutopilotRequestError, autopilotOutputUrl, cancelAutopilotJob, confirmDirectorDraft, getAutopilotOverview, getDirectorProviders, getDirectorTask, importDirectorPlan, resumeAutopilotJob, revealAutopilotOutput, startAutopilotJob, startDirectorDraft, type AutopilotOverview, type DirectorProviderInfo } from "@/lib/autopilot-client";
import { buildRevisionRequest, packageFromPlan, requestFromM2, unwrapPackageText, type DirectorPackageRequest, type ExternalProviderLabel } from "@/lib/autopilot-package";
import { formatClock } from "@/lib/final-cut-list";
import { StoryChapterPlanner } from "@/components/story-chapter-planner";


const FORM_KEY = "frameflow.autopilot.m2.request.v1";
/** Last request typed in this browser (per-viewer convenience; any problem → start empty). */
function readSavedForm(): SavedForm | null {
  try {
    const value = JSON.parse(window.localStorage.getItem(FORM_KEY) ?? "null") as Partial<SavedForm> | null;
    if (!value || typeof value !== "object") return null;
    const preset = value.preset && M2_PRESETS[value.preset] ? value.preset : M2_DEFAULT_PRESET;
    const text = (item: unknown) => typeof item === "string" ? item : "";
    return {
      intent: text(value.intent), seconds: typeof value.seconds === "number" ? value.seconds : M2_DEFAULT_SECONDS, aspect: typeof value.aspect === "string" ? value.aspect : M2_DEFAULT_ASPECT, preset,
      rules: { ...M2_PRESETS[preset].constraints, ...(value.rules ?? {}) }, facts: text(value.facts), forbidden: text(value.forbidden), terms: text(value.terms),
      anchor: { subjectName: text(value.anchor?.subjectName), subjectDescription: text(value.anchor?.subjectDescription), sceneAnchor: text(value.anchor?.sceneAnchor) },
      packageText: text(value.packageText), taskText: text(value.taskText),
    };
  } catch { return null; }
}
interface SavedForm { intent: string; seconds: number; aspect: string; preset: M2PresetId; rules: DirectorConstraints; facts: string; forbidden: string; terms: string; anchor: { subjectName: string; subjectDescription: string; sceneAnchor: string }; packageText: string; taskText: string }

/** Hard constraints (filled by the preset, checked by the program for every director model). */
const lines = (value: string) => value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
const CONSTRAINT_LABELS: [keyof DirectorConstraints, string][] = [["allowDialogue", "允许对白"], ["allowVoiceover", "允许旁白"], ["allowReadableText", "允许可读文字"], ["allowGeneratedUI", "允许生成 App / 界面"], ["allowNumbers", "允许数字 / 金额"]];
/**
 * 【夜班】 Autopilot panel. M2 (default): one sentence → director plan → 【开始制作】 → draft MP4.
 * M1: the fixed three-shot test. The panel starts jobs and shows the local worker's ledger; the work
 * itself runs in the dev server, so this panel (or the whole tab) can be closed at any time.
 * It never touches the current canvas.
 */

const pad2 = (value: number) => String(value).padStart(2, "0");
const RULE_TEXT: [keyof DirectorConstraints, string, string][] = [["allowDialogue", "有对白", "无对白"], ["allowVoiceover", "可旁白", "无旁白"], ["allowReadableText", "可有文字", "无可读文字"], ["allowGeneratedUI", "可有界面", "无界面"], ["allowNumbers", "可有数字", "无数字"]];
const rulesText = (rules: DirectorConstraints | undefined) => rules ? RULE_TEXT.map(([key, yes, no]) => rules[key] ? yes : no).join(" · ") : "—";
const list = (items: string[]) => items.filter(Boolean).join("；");
const spanText = (ms: number | null) => { if (ms === null || !Number.isFinite(ms) || ms < 0) return "—"; const seconds = Math.round(ms / 1000); return seconds >= 60 ? `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒` : `${seconds} 秒`; };

/** ✅ / ❌ lines: the plan check (PlanCheck) and the 【开始制作】 gate share this view. */
function CheckList({ title, items }: { title: string; items: { key: string; label: string; state: "pass" | "fail" | "skipped"; details: string[] }[] }) {
  return <section className="autopilot-checks">
    <h3>{title}</h3>
    <ul>{items.map((item) => <li key={item.key} className={`check-${item.state}`}>
      <span aria-hidden>{item.state === "pass" ? "✅" : item.state === "fail" ? "❌" : "·"}</span>
      <div><b>{item.label}</b>{item.state === "skipped" && <small>未检查</small>}{item.state !== "pass" && item.details.map((detail) => <small key={detail}>{detail.replace(/\[[a-z_]+\]\s*/, "")}</small>)}{item.state === "pass" && item.details[0] && <small>{item.details[0]}</small>}</div>
    </li>)}</ul>
  </section>;
}
const planCheckItems = (checks: PlanCheck[]) => checks.map((check) => ({ key: check.id, label: check.label, state: check.state, details: check.problems }));
const gateItems = (checks: ProductionGateCheck[]) => checks.map((check) => ({ key: check.id, label: check.label, state: check.state, details: check.state === "skipped" ? [] : [check.detail] }));

/** The frozen director plan: what each Shot shows and how, its legal length, and the exact submitted prompt. */
function PlanView({ job, open }: { job: AutopilotJob; open: boolean }) {
  const m2 = job.m2;
  if (!m2?.compiled || !m2.plan) return null;
  const nameOf = (id: string) => m2.plan?.characters.find((character) => character.id === id)?.name ?? id;
  const body = <>
    <dl className="rough-cut-summary">
      {m2.planSource === "external_ai" && m2.importInfo && <><dt>来源</dt><dd>外部AI计划（{m2.importInfo.providerLabel === "other" ? "其他" : m2.importInfo.providerLabel}，用户标记）<small>{m2.importInfo.packageVersion} · sha256 {m2.importInfo.packageHash.slice(0, 12)} · {m2.importInfo.expectedMatched ? "已与画布需求核对" : "未与画布需求核对"}</small></dd></>}
      <dt>一句话</dt><dd>{m2.intent}</dd>
      <dt>计划</dt><dd>{m2.plan.title}<small>{m2.plan.logline}</small></dd>
      <dt>镜头</dt><dd>{m2.compiled.length} 个 · 预计 {(m2.totalSeconds ?? 0).toFixed(1)} 秒（目标约 {m2.targetSeconds} 秒）</dd>
      {m2.subjectAnchor && <><dt>主体锚点</dt><dd>{m2.subjectAnchor.subjectName}<small>{m2.subjectAnchor.subjectDescription}{m2.subjectAnchor.sceneAnchor ? ` · 场景：${m2.subjectAnchor.sceneAnchor}` : ""}</small></dd></>}
      <dt>题材</dt><dd>{M2_PRESETS[m2.preset ?? M2_DEFAULT_PRESET].label}<small>{rulesText(m2.constraints)}{m2.approvedFacts?.length ? ` · ${m2.approvedFacts.length} 条已批准事实` : ""}</small></dd>
      <dt>规格</dt><dd>{m2.aspect} · 文生视频 T2VA · 0.50MP · 24 FPS · Turbo<small>导演：{m2.director.label}{m2.attempts.length > 1 ? " · 经过 1 次修正" : ""}</small></dd>
    </dl>
    {m2.warnings.length > 0 && <ul className="rough-cut-warnings">{m2.warnings.map((warning) => <li key={warning}>△ {warning}</li>)}</ul>}
    <ol className="autopilot-plan">
      {m2.compiled.map((shot) => {
        const s = shot.semantic;
        return <li key={shot.index}>
          <header><b>Shot {pad2(shot.index)} · {shot.title}</b><span>{shot.plannedSeconds} 秒 → {shot.length} 帧（{shot.actualSeconds.toFixed(2)} 秒）</span></header>
          {s ? <>
            <p>{s.purpose}</p>
            <p><em>事件</em>{s.openingState} {s.event} {s.endingState}</p>
            <p><em>角色</em>{s.characters.length ? s.characters.map(nameOf).join("、") : "无"}</p>
            {s.dialogue.length ? s.dialogue.map((line, position) => <p key={position}><em>台词</em>{nameOf(line.speaker)}{line.voiceover ? "（旁白）" : ""}：“{line.text}”</p>) : <p><em>台词</em>无</p>}
            <p><em>机位</em>{s.camera.shotSize}{s.camera.target ? ` · 对准 ${s.camera.target}` : ""}　<em>运镜</em>{s.camera.motion}{s.camera.motion !== "static" ? `（${s.camera.amplitude} / ${s.camera.speed}）` : ""}{s.forbiddenCameraMotion.length ? ` · 禁止 ${s.forbiddenCameraMotion.join(" / ")}` : ""}</p>
            <p><em>声音</em>{list([s.ambientSound, ...s.physicalSounds, ...s.nonVerbalSounds, s.nonDiegeticMusicIntent ? `配乐：${s.nonDiegeticMusicIntent}` : ""])}</p>
            {(s.invariants.length > 0 || s.visualConstraints.length > 0 || s.forbiddenContent.length > 0) && <p><em>约束</em>{list([...s.invariants.map((item) => `保持 ${item}`), ...s.visualConstraints, ...(s.forbiddenContent.length ? [`不出现：${s.forbiddenContent.join("、")}`] : [])])}</p>}
          </> : null}
          <details><summary>编译器生成的 H3 Prompt（{shot.compilerVersion ?? "旧版"}）</summary><pre>{shot.submitPrompt}</pre></details>
        </li>;
      })}
    </ol>
  </>;
  return open ? <section className="autopilot-plan-block">{body}</section> : <details className="autopilot-plan-block"><summary>查看导演计划</summary>{body}</details>;
}

/** 【草稿已完成】: where the file is, how long it took, and which Run produced each Shot. */
function ResultView({ job }: { job: AutopilotJob }) {
  const m2 = job.m2;
  if (!m2 || job.status !== "completed") return null;
  const retries = job.shots.reduce((sum, shot) => sum + Math.max(0, shot.attempts.length - 1), 0);
  return <section className="autopilot-result">
    <dl className="rough-cut-summary">
      <dt>成片</dt><dd>{job.finalFilename}</dd>
      <dt>总时长</dt><dd>{formatClock(job.finalDuration)}{job.roughCutOutput ? <small>{job.roughCutOutput.width}×{job.roughCutOutput.height} · {Number(job.roughCutOutput.fps.toFixed(3))} FPS · H.264 + AAC</small> : null}</dd>
      <dt>镜头数量</dt><dd>{job.shots.length} 个</dd>
      <dt>生成耗时</dt><dd>{spanText(m2.confirmedAt && job.completedAt ? Date.parse(job.completedAt) - Date.parse(m2.confirmedAt) : null)}<small>从【开始制作】到粗剪完成</small></dd>
      <dt>导演修正</dt><dd>{m2.attempts.length > 1 ? "有（第一次计划未通过，修正 1 次后通过）" : "没有（第一次计划直接通过）"}</dd>
      <dt>H3 重试</dt><dd>{retries ? `${retries} 次` : "没有"}</dd>
      <dt>输出路径</dt><dd className="muted-id">{job.finalOutputPath}</dd>
      {job.reportFile && <><dt>制作报告</dt><dd className="muted-id">{job.jobId}/{job.reportFile}</dd></>}
    </dl>
    <ol className="autopilot-runs">{job.shots.map((shot) => <li key={shot.shotId}><span>{shot.title}</span><b className="muted-id">Run {shot.runId?.slice(0, 8) ?? "—"}</b><small>{shot.attempts.length > 1 ? `第 ${shot.attempts.length} 次提交（前 ${shot.attempts.length - 1} 次未成功）` : "一次成功"}{shot.media ? ` · ${shot.media.duration.toFixed(2)} 秒` : ""}</small></li>)}</ol>
  </section>;
}

const HEARTBEAT_STALE_MS = 60_000;
const timeText = (iso: string | null) => iso ? new Date(iso).toLocaleString("zh-CN", { hour12: false }) : "—";

function ShotIcon({ status }: { status: ShotTask["status"] | "rough" }) {
  if (status === "completed") return <CircleCheck size={14} className="autopilot-icon ok" />;
  if (status === "failed") return <CircleX size={14} className="autopilot-icon failed" />;
  if (status === "needs_confirmation") return <CircleAlert size={14} className="autopilot-icon warn" />;
  if (status === "cancelled") return <CircleX size={14} className="autopilot-icon muted" />;
  if (status === "pending") return <Circle size={14} className="autopilot-icon muted" />;
  return <LoaderCircle size={14} className="autopilot-icon busy" />;
}

/** Header dot: is a night job unfinished? Polls slowly only while one is. */
export function useAutopilotActive(panelOpen: boolean) {
  const [active, setActive] = useState(false);
  useEffect(() => {
    if (panelOpen) return;
    let alive = true; let timer: number | undefined;
    const check = async () => {
      const next = await getAutopilotOverview().then((overview) => Boolean(overview.active)).catch(() => false);
      if (!alive) return;
      setActive(next);
      if (next) timer = window.setTimeout(() => void check(), 20_000);
    };
    void check();
    return () => { alive = false; window.clearTimeout(timer); };
  }, [panelOpen]);
  return active;
}

export function AutopilotPanel({ onClose }: { onClose: () => void }) {
  const [overview, setOverview] = useState<AutopilotOverview | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [notice, setNotice] = useState("");
  const [checkedAt, setCheckedAt] = useState(0);
  const [mode, setMode] = useState<"m2" | "m1">("m2");
  // The request lives in this browser between 复制 and 导入 (the user goes to a chat window in between).
  const [saved] = useState(readSavedForm);
  const [intent, setIntent] = useState(saved?.intent ?? "");
  const [seconds, setSeconds] = useState(saved?.seconds ?? M2_DEFAULT_SECONDS);
  const [aspect, setAspect] = useState<string>(saved?.aspect ?? M2_DEFAULT_ASPECT);
  const [directors, setDirectors] = useState<DirectorProviderInfo[]>([]);
  const [director, setDirector] = useState("");
  const [facts, setFacts] = useState(saved?.facts ?? "");
  const [forbidden, setForbidden] = useState(saved?.forbidden ?? "");
  const [preset, setPreset] = useState<M2PresetId>(saved?.preset ?? M2_DEFAULT_PRESET);
  const [rules, setRules] = useState<DirectorConstraints>(saved?.rules ?? M2_PRESETS[M2_DEFAULT_PRESET].constraints);
  const [anchor, setAnchor] = useState(saved?.anchor ?? { subjectName: "", subjectDescription: "", sceneAnchor: "" });
  const [terms, setTerms] = useState(saved?.terms ?? "");
  const [packageText, setPackageText] = useState(saved?.packageText ?? "");
  const [providerLabel, setProviderLabel] = useState<ExternalProviderLabel>("GPT");
  const [importIssues, setImportIssues] = useState<{ errors: string[]; checks: PlanCheck[] | null } | null>(null);
  const [revision, setRevision] = useState("");
  const [taskText, setTaskText] = useState(saved?.taskText ?? "");
  const alive = useRef(true);
  useEffect(() => {
    try { window.localStorage.setItem(FORM_KEY, JSON.stringify({ intent, seconds, aspect, preset, rules, facts, forbidden, terms, anchor, packageText, taskText } satisfies SavedForm)); }
    catch { setNotice("夜班草稿保存失败，请复制保留输入内容；当前操作仍可继续。"); }
  }, [intent, seconds, aspect, preset, rules, facts, forbidden, terms, anchor, packageText, taskText]);
  useEffect(() => () => { alive.current = false; }, []);
  useEffect(() => {
    void getDirectorProviders().then((info) => { if (!alive.current) return; setDirectors(info.providers); setDirector(info.defaultDirector); }).catch(() => {});
  }, []);

  const refresh = useCallback(async () => {
    try { const next = await getAutopilotOverview(); if (alive.current) { setOverview(next); setCheckedAt(Date.now()); setError(""); } }
    catch (cause) { if (alive.current) setError(cause instanceof Error ? cause.message : "读取夜班任务失败"); }
  }, []);

  const job: AutopilotJob | null = overview?.active ?? overview?.latest ?? null;
  const active = job ? isActiveAutopilotJob(job) : false;
  const moving = job ? RUNNING_AUTOPILOT_STATUSES.includes(job.status) : false;

  // First load, then follow the worker while the job is unfinished (reading only).
  useEffect(() => {
    let timer: number | undefined;
    const tick = async () => { await refresh(); timer = window.setTimeout(() => void tick(), moving ? 2_000 : active ? 5_000 : 30_000); };
    void tick();
    return () => window.clearTimeout(timer);
  }, [refresh, moving, active]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") { event.stopPropagation(); onClose(); } };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  const act = async (action: () => Promise<unknown>, done?: string) => {
    setBusy(true); setError(""); setNotice("");
    try { await action(); if (done) setNotice(done); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "操作失败"); }
    finally { setBusy(false); setConfirmCancel(false); await refresh(); }
  };

  const start = () => act(async () => { setPlaying(false); await startAutopilotJob(); });
  const plan = () => act(async () => { setPlaying(false); await startDirectorDraft({ intent: intent.trim(), targetSeconds: seconds, aspect, director: director || undefined, preset, approvedFacts: lines(facts), forbiddenClaims: lines(forbidden), constraints: rules, subjectAnchor: Object.values(anchor).some((value) => value.trim()) ? anchor : null }); });
  const hasAnchor = Object.values(anchor).some((value) => value.trim());
  const currentRequest = (): DirectorPackageRequest => ({
    brief: intent.trim(), targetDurationSeconds: seconds, aspectRatio: aspect as M2Aspect, preset, constraints: { ...rules, forbiddenTerms: lines(terms) },
    subjectAnchor: hasAnchor ? anchor : null, approvedFacts: lines(facts), forbiddenClaims: lines(forbidden),
  });
  const copyText = async (value: string, done: string) => {
    try { await navigator.clipboard.writeText(value); setTaskText(""); setNotice(done); }
    catch { setTaskText(value); setNotice(""); }
  };
  const copyTask = () => act(async () => { const task = await getDirectorTask(currentRequest()); await copyText(task.text, "已复制任务说明：粘贴到 GPT / Claude，把它返回的 JSON 粘回下面的【AI导演计划】"); });
  const importPlan = async () => {
    setBusy(true); setError(""); setNotice(""); setImportIssues(null);
    try {
      await importDirectorPlan({ packageText, providerLabel, expected: intent.trim() ? currentRequest() : null });
      setPackageText(""); setRevision(""); setNotice("导演计划已导入，检查全部通过");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "导入失败");
      if (cause instanceof AutopilotRequestError && cause.details) setImportIssues({ errors: cause.details.errors ?? [], checks: cause.details.checks ?? null });
      else setImportIssues({ errors: [cause instanceof Error ? cause.message : "导入失败"], checks: null });
    } finally { setBusy(false); await refresh(); }
  };
  const loadPackageFile = async (file: File | undefined) => {
    if (!file) return;
    if (file.size > 512 * 1024) { setError("计划文件太大（上限 512 KB）"); return; }
    setPackageText(await file.text()); setImportIssues(null);
  };
  /** 【复制修改要求】 for a pasted package that did not pass: the problems + the package as pasted. */
  const copyRevisionFromPaste = () => act(async () => {
    let pasted: unknown;
    try { pasted = JSON.parse(unwrapPackageText(packageText)); } catch { throw new Error("粘贴的内容不是完整的 JSON，没法据此生成修改要求：请让 GPT / Claude 重新只返回 JSON"); }
    await copyText(buildRevisionRequest(pasted, revision, importIssues?.errors ?? []), "已复制修改要求：发给 GPT / Claude，把新版 JSON 粘回来重新导入");
  });
  /** 【复制修改要求】 for a plan that passed (imported or local): the plan rebuilt as a package + what to change. */
  const copyRevisionFromJob = (target: AutopilotJob) => act(async () => {
    if (!target.m2?.plan) return;
    await copyText(buildRevisionRequest(packageFromPlan({ plan: target.m2.plan, request: requestFromM2(target.m2) }), revision, []), "已复制修改要求：发给 GPT / Claude，把新版 JSON 粘回来重新导入（需先放弃当前计划）");
  });
  const presetInfo = M2_PRESETS[preset];
  const suggestion = intent.trim() ? suggestPreset(intent) : null;
  const needsFacts = presetInfo.requiresApprovedFacts && !lines(facts).length;
  // A preset only fills the switches; the user can still change them under 高级.
  const choosePreset = (id: M2PresetId) => { setPreset(id); setRules(M2_PRESETS[id].constraints); };
  const isM2 = job?.kind === AUTOPILOT_M2_KIND;
  const selected = directors.find((item) => item.id === director);
  const cancel = () => { if (!job) return; if (!confirmCancel) { setConfirmCancel(true); return; } void act(() => cancelAutopilotJob(job.jobId)); };
  const pendingShot = job?.shots.find((shot) => shot.status === "needs_confirmation") ?? null;
  const stale = job && moving && checkedAt - Date.parse(job.lastHeartbeat) > HEARTBEAT_STALE_MS;
  const readOnly = overview ? !overview.owner : false;
  const currentShot = job?.currentShotIndex ? job.shots[job.currentShotIndex - 1] : null;

  const factsField = <label className="autopilot-field"><span>{presetInfo.requiresApprovedFacts ? "已批准的产品事实（每行一条，至少一条；导演只能用这些说法）" : "已批准的事实（可选，每行一条）"}</span><textarea rows={3} value={facts} onChange={(event) => setFacts(event.target.value)} placeholder="例如：全厘是装修总预算规划工具" /></label>;
  const m2Form = <>
    <StoryChapterPlanner disabled={busy || active || readOnly} onUse={(brief, duration) => { setIntent(brief); setSeconds(duration); setPackageText(""); setImportIssues(null); setTaskText(""); }} />
    <p className="ff-hint autopilot-lead">① 写需求 → ②【复制给GPT / Claude】→ ③ 把返回的 JSON 粘回来【导入并检查】→ ④ 检查全部通过后点【开始夜班制作】。最终 H3 Prompt 由本地编译器生成。</p>
    <label className="autopilot-field"><span>一句话需求</span><textarea value={intent} maxLength={M2_INTENT_MAX} rows={3} placeholder="例如：一架现代垂直起降战斗机从公路板车上起飞，最后冲向远处天空" onChange={(event) => setIntent(event.target.value)} /></label>
    <div className="autopilot-field"><span>题材</span>
      <div className="autopilot-presets" role="radiogroup" aria-label="题材预设">{M2_PRESET_IDS.map((id) => <button key={id} type="button" role="radio" aria-checked={preset === id} title={M2_PRESETS[id].hint} onClick={() => choosePreset(id)}>{M2_PRESETS[id].label}</button>)}</div>
      <small className="autopilot-hint">{presetInfo.hint}</small>
    </div>
    {suggestion && suggestion.preset !== preset && <p className="autopilot-suggest">建议题材：{M2_PRESETS[suggestion.preset].label}（{suggestion.reason}）<button type="button" onClick={() => choosePreset(suggestion.preset)}>改用</button></p>}
    <div className="autopilot-row">
      <label className="autopilot-field"><span>目标时长</span><select value={seconds} onChange={(event) => setSeconds(Number(event.target.value))}>{[15, 20, 30, 45, 60].filter((value) => value >= M2_SECONDS_RANGE.min && value <= M2_SECONDS_RANGE.max).map((value) => <option key={value} value={value}>约 {value} 秒</option>)}</select></label>
      <label className="autopilot-field"><span>画面比例</span><select value={aspect} onChange={(event) => setAspect(event.target.value)}>{M2_ASPECTS.map((value) => <option key={value} value={value}>{value}{value === M2_DEFAULT_ASPECT ? "（默认竖屏）" : ""}</option>)}</select></label>
    </div>
    {presetInfo.requiresApprovedFacts && factsField}
    {needsFacts && <p className="role-error">【{PRODUCT_FACTS_REQUIRED_MESSAGE}】</p>}
    <details className="autopilot-facts"><summary>主体锚点（可选：跨镜头固定主体是什么、长什么样）</summary>
      <span className="autopilot-hint">由程序原样写进每个镜头的最终 Prompt，导演只决定主体在每镜做什么。描述用英文。</span>
      <label className="autopilot-field"><span>主体名称</span><input value={anchor.subjectName} maxLength={40} onChange={(event) => setAnchor((current) => ({ ...current, subjectName: event.target.value }))} placeholder="例如：现代垂直起降战斗机" /></label>
      <label className="autopilot-field"><span>主体描述（英文，必填才生效）</span><textarea rows={2} maxLength={300} value={anchor.subjectDescription} onChange={(event) => setAnchor((current) => ({ ...current, subjectDescription: event.target.value }))} placeholder="a realistic gray modern VTOL fighter jet with …" /></label>
      <label className="autopilot-field"><span>场景锚点（英文，可选）</span><textarea rows={2} maxLength={300} value={anchor.sceneAnchor} onChange={(event) => setAnchor((current) => ({ ...current, sceneAnchor: event.target.value }))} placeholder="a long heavy-duty flatbed trailer on a paved public road" /></label>
    </details>
    <details className="autopilot-facts"><summary>约束 / 禁用词</summary>
      <span className="autopilot-hint">硬约束（由题材自动填写，可手动调整；程序按这里判定计划）</span>
      <div className="autopilot-rules">{CONSTRAINT_LABELS.map(([key, label]) => <label key={key}><input type="checkbox" checked={rules[key]} onChange={(event) => setRules((current) => ({ ...current, [key]: event.target.checked }))} />{label}</label>)}</div>
      {!presetInfo.requiresApprovedFacts && factsField}
      <label className="autopilot-field"><span>禁用词（每行一个，例如 rotor、helicopter）</span><textarea rows={2} value={terms} onChange={(event) => setTerms(event.target.value)} /></label>
      <label className="autopilot-field"><span>禁止的说法（每行一条）</span><textarea rows={2} value={forbidden} onChange={(event) => setForbidden(event.target.value)} /></label>
    </details>
    <div className="autopilot-actions-row">
      <button type="button" disabled={busy || !intent.trim() || needsFacts} onClick={() => void copyTask()}><Copy size={14} />复制给GPT / Claude</button>
      <small className="ff-hint autopilot-hint">生成一份任务说明（需求、约束、导演规则、输出格式），粘贴到 GPT / Claude 聊天窗口。</small>
    </div>
    {taskText && <label className="autopilot-field"><span>浏览器不允许自动复制：请手动全选复制下面的任务说明</span><textarea rows={5} readOnly value={taskText} onFocus={(event) => event.target.select()} /></label>}
    <section className="autopilot-import">
      <h3>AI导演计划</h3>
      <label className="autopilot-field"><span>粘贴 GPT / Claude 返回的 Director Plan JSON（纯 JSON 或一个 ```json 代码块）</span><textarea rows={6} value={packageText} spellCheck={false} onChange={(event) => { setPackageText(event.target.value); setImportIssues(null); }} placeholder={'{"packageVersion": "director-plan-package-v1", …}'} /></label>
      <div className="autopilot-row">
        <label className="autopilot-field"><span>计划来自</span><select value={providerLabel} onChange={(event) => setProviderLabel(event.target.value as ExternalProviderLabel)}><option value="GPT">GPT</option><option value="Claude">Claude</option><option value="other">其他</option></select></label>
        <label className="autopilot-field"><span>或导入 .json 文件</span><input type="file" accept=".json,application/json" onChange={(event) => void loadPackageFile(event.target.files?.[0])} /></label>
      </div>
      <small className="autopilot-hint">{intent.trim() ? "导入时会核对计划包里的需求、约束、主体锚点、事实与上面的设置一致。" : "上面没有填写需求：导入时不做需求核对，只按计划包自己的设置检查。"}</small>
      {importIssues && <>
        {importIssues.errors.length > 0 && <ul className="rough-cut-warnings">{importIssues.errors.slice(0, 12).map((problem) => <li key={problem}>❌ {problem.replace(/\[[a-z_]+\]\s*/, "")}</li>)}</ul>}
        {importIssues.checks && <CheckList title="计划检查" items={planCheckItems(importIssues.checks)} />}
        <label className="autopilot-field"><span>修改要求（可选，例如：只修改 Shot 03：……）</span><textarea rows={2} value={revision} onChange={(event) => setRevision(event.target.value)} /></label>
        <button type="button" disabled={busy} onClick={() => void copyRevisionFromPaste()}><Copy size={14} />复制修改要求</button>
      </>}
    </section>
    <details className="autopilot-facts"><summary>高级 / 调试</summary>
      <span className="autopilot-hint">【实验】使用本地 AI 自动规划：不经过聊天窗口，由本机导演模型直接出计划（纪律不如 GPT / Claude 稳定）。</span>
      <label className="autopilot-field"><span>导演模型</span><select value={director} onChange={(event) => setDirector(event.target.value)}>{directors.map((item) => <option key={item.id} value={item.id} disabled={!item.available} title={item.reason ?? undefined}>{item.label}{item.available ? "" : "（不可用）"}</option>)}</select></label>
      {directors.some((item) => !item.available) && <p className="backup-note">{directors.filter((item) => !item.available).map((item) => `${item.label}：${item.reason ?? "不可用"}`).join("；")}</p>}
      {selected?.kind === "mock" && <p className="ff-hint backup-note">当前是 Mock 导演：只用于验证流水线，计划内容是固定模板，不代表真实导演质量。</p>}
      <button type="button" disabled={busy || !intent.trim() || !selected?.available || needsFacts} onClick={() => void plan()}><Clapperboard size={14} />使用本地AI自动规划（实验）</button>
    </details>
    <p className="backup-note">3–6 个文生视频镜头（T2VA · 0.50MP · 24 FPS · Turbo），约 {seconds} 秒。计划不合格就不能开始，不会提交任何 H3；点【开始夜班制作】时会再检查一遍，然后逐镜串行生成并自动粗剪。关闭页面也会继续运行，不会修改当前画布。</p>
  </>;

  const intro = <>
    <p className="ff-hint autopilot-lead">【启动后可以关闭画布页面，后台会继续工作。】</p>
    <dl className="rough-cut-summary">
      <dt>镜头</dt><dd>{AUTOPILOT_M1_SHOTS.map((shot) => shot.title).join(" → ")}</dd>
      <dt>生成</dt><dd>文生视频 T2VA · {AUTOPILOT_M1_SETTINGS.megapixels.toFixed(2)}MP · {AUTOPILOT_M1_SETTINGS.fps} FPS · Turbo · {AUTOPILOT_M1_SETTINGS.length} 帧（约 {(AUTOPILOT_M1_SETTINGS.length / AUTOPILOT_M1_SETTINGS.fps).toFixed(1)} 秒）· 仅环境音<small className="ff-hint">T2VA 沿用已验证的 H3 模型与参数，但本身仍待真人 GPU 验收</small></dd>
      <dt>顺序</dt><dd>严格串行：一个镜头完成并保存后才提交下一个 → 本地 PyAV 粗剪（01 → 02 → 03，硬切、保留声音）</dd>
      <dt>输出</dt><dd>Autopilot_M1_test_时间.mp4<small className="ff-hint">保存在项目 runtime/autopilot 下；不会修改当前画布</small></dd>
    </dl>
  </>;

  const starter = <>
    <div className="autopilot-tabs" role="tablist">
      <button type="button" role="tab" aria-selected={mode === "m2"} onClick={() => setMode("m2")}>M2 AI导演计划</button>
      <button type="button" role="tab" aria-selected={mode === "m1"} onClick={() => setMode("m1")}>M1 三镜头测试</button>
    </div>
    {mode === "m2" ? m2Form : intro}
  </>;

  return createPortal(<div className="generation-info-backdrop" onPointerDown={(event) => { event.stopPropagation(); if (event.target === event.currentTarget) onClose(); }}>
    <section className="generation-info-panel ff-panel rough-cut-panel autopilot-panel" role="dialog" aria-modal="true" aria-label="夜班测试" onPointerDown={(event) => event.stopPropagation()}>
      <header><div><small>{(active ? isM2 : mode === "m2") ? "Autopilot M2" : "Autopilot M1"}</small><h2>{(active ? isM2 : mode === "m2") ? "AI导演计划 → 夜间草稿" : "三镜头无人值守测试"}</h2></div><button type="button" aria-label="关闭夜班测试" onClick={onClose}><X size={17} /></button></header>
      <div className="rough-cut-body">
        {error && <p className="role-error" role="alert">【{error}】</p>}
        {notice && <p className="role-notice">{notice}</p>}
        {readOnly && <p className="role-notice">夜班任务由另一个开发服务器进程（PID {overview?.ownerPid ?? "?"}）负责：这里只能查看。</p>}
        {!overview && !error && <p className="rough-cut-stage"><LoaderCircle size={15} />读取夜班任务…</p>}
        {overview && !job && starter}
        {job && <>
          {job.status === "completed" && <p className="autopilot-banner ok">{isM2 ? "【草稿已完成】" : "【夜班任务完成】"}</p>}
          {job.status === "failed" && <p className="autopilot-banner failed">【{job.failure ? AUTOPILOT_FAILURE_LABELS[job.failure.kind] : "夜班任务失败"}】{job.stageText}</p>}
          {job.status === "cancelled" && <p className="autopilot-banner muted">夜班任务已取消</p>}
          {job.status === "planning_failed" && <p className="autopilot-banner failed">【导演计划未通过，未开始视频生成】{job.stageText}</p>}
          {job.status === "preflight_failed" && <p className="autopilot-banner failed">【开始前检查未通过，未开始视频生成】{job.failure?.message ?? job.stageText}</p>}
          {job.status === "paused" && <p className="autopilot-banner warn">【夜班任务已暂停】{job.pauseReason}</p>}
          {job.status === "awaiting_confirmation" && (job.failure
            ? <p className="autopilot-banner warn">【{AUTOPILOT_FAILURE_LABELS[job.failure.kind]}】{job.failure.message}</p>
            : <p className="autopilot-banner ok">{job.m2?.planSource === "external_ai" ? "【导演计划已导入】检查全部通过，尚未占用 GPU。确认无误后点【开始夜班制作】" : "【导演计划已通过检查，尚未占用 GPU】确认无误后点【开始夜班制作】"}</p>)}
          {moving && <><p className="rough-cut-stage"><LoaderCircle size={15} />{job.stageText}</p><p className="autopilot-keepalive"><Moon size={13} />【关闭页面也会继续运行】</p></>}
          {stale && <p className="role-error">后台超过 1 分钟没有心跳：开发服务器可能已关闭。重新启动后任务会从账本恢复（不会重复提交）。</p>}
          <dl className="rough-cut-summary">
            <dt>任务 ID</dt><dd className="muted-id">{job.jobId}</dd>
            <dt>状态</dt><dd>{AUTOPILOT_STATUS_LABELS[job.status]}</dd>
            <dt>当前阶段</dt><dd>{job.stageText}</dd>
            <dt>当前 Shot</dt><dd>{currentShot ? currentShot.title : job.currentStage === "rough_cut" ? "粗剪" : "—"}</dd>
            <dt>开始时间</dt><dd>{timeText(job.createdAt)}</dd>
            {job.completedAt && <><dt>结束时间</dt><dd>{timeText(job.completedAt)}</dd></>}
          </dl>
          {isM2 && <PlanView job={job} open={job.status === "awaiting_confirmation"} />}
          {isM2 && job.m2?.checks && (job.status === "awaiting_confirmation" || job.status === "planning_failed") && <CheckList title="计划检查" items={planCheckItems(job.m2.checks)} />}
          {isM2 && job.m2?.gate && (job.status === "awaiting_confirmation" || job.status === "preflight_failed" || !job.m2.gate.ok) && <CheckList title="开始制作前检查" items={gateItems(job.m2.gate.checks)} />}
          {isM2 && <ResultView job={job} />}
          {isM2 && job.status === "awaiting_confirmation" && !readOnly && <details className="autopilot-facts"><summary>不满意？复制修改要求给 GPT / Claude</summary>
            <label className="autopilot-field"><span>修改要求（例如：只修改 Shot 03：战机要升到板车明显变小）</span><textarea rows={2} value={revision} onChange={(event) => setRevision(event.target.value)} /></label>
            <button type="button" disabled={busy} onClick={() => void copyRevisionFromJob(job)}><Copy size={14} />复制修改要求</button>
            <small className="ff-hint autopilot-hint">拿到新版 JSON 后：先【放弃计划】，再在【AI导演计划】中粘贴导入。</small>
          </details>}
          {job.shots.length > 0 && job.status !== "awaiting_confirmation" && <ol className="autopilot-steps">
            {job.shots.map((shot) => <li key={shot.shotId} className={`status-${shot.status}`}>
              <ShotIcon status={shot.status} /><span>{shot.title}</span><b>{SHOT_STATUS_LABELS[shot.status]}{shot.retryCount ? ` · 已重试 ${shot.retryCount} 次` : ""}</b>
              {shot.error && shot.status !== "completed" && <small>{shot.error}</small>}
            </li>)}
            <li className={`status-${job.roughCutStatus}`}><ShotIcon status={job.roughCutStatus === "running" ? "running" : job.roughCutStatus} /><span>粗剪（{job.shots.map((shot) => pad2(shot.index)).join(" → ")}）</span><b>{ROUGH_CUT_STATUS_LABELS[job.roughCutStatus]}</b>{job.roughCutError && <small>{job.roughCutError}</small>}</li>
          </ol>}
          {!isM2 && job.status === "completed" && job.roughCutOutput && <dl className="rough-cut-summary">
            <dt>成片</dt><dd>{job.finalFilename}</dd>
            <dt>时长</dt><dd>{formatClock(job.finalDuration)}</dd>
            <dt>规格</dt><dd>{job.roughCutOutput.width}×{job.roughCutOutput.height} · {Number(job.roughCutOutput.fps.toFixed(3))} FPS · H.264 + AAC</dd>
            <dt>位置</dt><dd className="muted-id">{job.finalOutputPath}</dd>
          </dl>}
          {job.status === "completed" && playing && <video className="autopilot-video" src={autopilotOutputUrl(job.jobId)} controls autoPlay playsInline />}
          {(job.status === "failed" || job.status === "paused") && job.errorLog.length > 0 && <ul className="rough-cut-warnings">{job.errorLog.slice(-3).map((entry) => <li key={`${entry.at}-${entry.message}`}>△ {timeText(entry.at)} · {entry.message}</li>)}</ul>}
        </>}
        {job && !active && <section className="autopilot-again"><h3>新任务</h3>{starter}</section>}
      </div>
      <footer className="rough-cut-actions">
        {overview && !active && !readOnly && mode === "m2" && <button type="button" className="role-main-action" disabled={busy || !packageText.trim()} onClick={() => void importPlan()}><Upload size={14} />导入并检查</button>}
        {overview && !active && !readOnly && mode === "m1" && <button type="button" className="role-main-action" disabled={busy} onClick={() => void start()}><Moon size={14} />开始夜班测试</button>}
        {job?.status === "awaiting_confirmation" && !readOnly && <button type="button" className="role-main-action" disabled={busy} onClick={() => void act(() => confirmDirectorDraft(job.jobId))}><Play size={14} />开始夜班制作</button>}
        {job?.status === "completed" && <>
          <button type="button" onClick={() => setPlaying((value) => !value)}><Play size={14} />{playing ? "收起播放器" : "播放成片"}</button>
          <a className="autopilot-link" href={autopilotOutputUrl(job.jobId, true)} download={job.finalFilename ?? undefined}><Download size={14} />下载成片</a>
          <button type="button" disabled={busy} onClick={() => void act(() => revealAutopilotOutput(job.jobId), "已在资源管理器中定位成片文件")}><FolderSearch size={14} />定位输出文件</button>
          {isM2 && <button type="button" disabled title="后续版本提供：把草稿和各镜头送进无限画布">打开到无限画布</button>}
        </>}
        {job?.status === "paused" && !readOnly && <>
          {pendingShot
            ? <><button type="button" disabled={busy} onClick={() => void act(() => resumeAutopilotJob(job.jobId, false))}><RotateCcw size={14} />重新检查</button><button type="button" disabled={busy} title="只有 ComfyUI 中仍找不到原任务时才会重新提交" onClick={() => void act(() => resumeAutopilotJob(job.jobId, true))}>确认重新提交 {pendingShot.title.split(" · ")[0]}</button></>
            : <button type="button" className="role-main-action" disabled={busy} onClick={() => void act(() => resumeAutopilotJob(job.jobId, false))}><RotateCcw size={14} />继续</button>}
        </>}
        {active && !readOnly && !job?.cancelRequested && <button type="button" className={confirmCancel ? "danger" : undefined} disabled={busy} onClick={cancel}><Square size={13} />{job?.status === "awaiting_confirmation" ? (confirmCancel ? "确认放弃计划" : "放弃计划") : job?.status === "planning" ? (confirmCancel ? "确认取消规划" : "取消规划") : (confirmCancel ? "确认取消夜班任务" : "取消夜班任务")}</button>}
        <button type="button" onClick={onClose}>关闭</button>
      </footer>
    </section>
  </div>, document.body);
}
