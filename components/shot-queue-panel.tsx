"use client";

import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { Crosshair, X } from "lucide-react";
import { CanvasPanelBoundary, GuardedPanelRender } from "@/components/canvas-error-boundary";
import { useValue, type Editor, type TLShape } from "tldraw";
import { buildQueueCatalog, queueCatalogScope } from "@/lib/shot-queue-catalog";
import { useShotQueueExecution } from "@/components/use-shot-queue-execution";
import { useShotQueueDraft } from "@/components/use-shot-queue-draft";
import { downloadShotList, downloadQueueJson } from "@/lib/shot-list-download";
import { QueueHistoryStore, canUndo, canRedo, type QueueHistory } from "@/lib/shot-queue-history";
import { listShots, listAssets, getMeta, putMeta } from "@/lib/production-records";
import { listRoles, setPrimaryRoleAsset } from "@/lib/role-records";
import { copyPlainText } from "@/lib/copy-plain-text";
import { isTypingTarget } from "@/lib/keyboard-guards";
import { shotQueueJson } from "@/lib/episode-settings";
import { parseShotQueue, shotQueueWarnings, shotQueueMegapixels, shotQueueExample, shotQueueFrameExample, shotQueueH3Props, type ShotQueue } from "@/lib/shot-queue";
import { queueFrameDescription } from '@/lib/shot-queue-frames';
import { matchingInboxRequest, reportInboxRequest } from '@/lib/inbox-queue-protocol';
import { loadFrameflowInstance } from '@/lib/frameflow-instance';
import { ShotCardBoard } from "@/components/shot-card-board";
import { QueueCheckupList } from "@/components/queue-checkup-list";
import { planQueuePrimaries } from "@/lib/queue-role-primaries";
import { queueEstimate, formatEstimate, ESTIMATE_NOTE } from "@/lib/shot-time-estimate";
import type { BatchStartPlan } from "@/lib/shot-queue-batch-plan";
import { askConfirm } from "@/components/in-page-dialog";
import { InboxControlBar } from "@/components/inbox-control-bar";
import { NOT_QUEUED, SOFT_MESSAGE_MS, enqueueLabel } from "@/lib/shot-card-view-rules";
import { queueLockState, FORCE_UNLOCK_NOTE } from "@/lib/queue-stop";

type CreateProps = ReturnType<typeof shotQueueH3Props>;

const statusText: Record<string, string> = {
  submitting: "提交中",
  queued: "ComfyUI 排队中",
  unconfirmed: "任务状态待确认（不会重提）",
  pending: "待提交",
  running: "正在生成",
  completed: "已生成，待采用",
  failed: "失败",
  stopped: "未提交",
};

/** Automatic queues: give a role its 主外观 only when it has exactly one 外观图 (see planQueuePrimaries). */
async function ensureQueuePrimaries(parsed: ShotQueue) {
  const plan = planQueuePrimaries(parsed, await listRoles());
  if (plan.error) throw new Error(plan.error);
  for (const item of plan.set) await setPrimaryRoleAsset(item.roleId, item.assetId, "image");
}

/** Ask the canvas to show the card board (the canvas owns visibility). Never parses or loads anything. */
const showCards = () => window.dispatchEvent(new Event("frameflow-show-shot-cards"));

/**
 * 镜头卡片的「状态主人」：队列文本、入队执行、收件箱新队列都在这里，永远挂载（卡片关着也在跑）。
 * 2026-11-11 起没有单独的「队列」面板了：卡片打开时渲染 ShotCardBoard，原队列面板的全部内容变成卡片顶栏
 * 「JSON / 进度」抽屉（下面的 <aside className="sc-queue-drawer">）。没有队列时抽屉直接打开。
 * 提交逻辑（useShotQueueExecution / 收件箱）没有改，只搬了界面。
 */
// 入队确认框：页面正中间（不在右边抽屉里），样式和 in-page-dialog 一致，黑白灰。
const ASK_SHADE: CSSProperties = { position: "fixed", inset: 0, zIndex: 100000, display: "grid", placeItems: "center", background: "rgba(0,0,0,.55)", pointerEvents: "auto" };
const ASK_PANEL: CSSProperties = { width: "min(560px,92vw)", maxHeight: "80vh", overflow: "auto", margin: 0, padding: 20, border: "1px solid var(--ff-border-strong,#3a3a3a)", borderRadius: 12, background: "var(--ff-raised,#1b1b1b)", color: "var(--ff-text,#ededed)", boxShadow: "0 16px 60px rgba(0,0,0,.6)", fontSize: 14, lineHeight: 1.7 };

export function ShotQueuePanel({ editor, onClose, createNode, focusNode, origin, autoSubmitText, autoSubmitRequestId, persistenceKey, visible = true }: {
  editor: Editor;
  visible?: boolean;
  persistenceKey: string;
  onClose: () => void;
  createNode: (props: CreateProps, point: { x: number; y: number },signal?:AbortSignal) => Promise<{ id: string } | undefined>;
  focusNode: (id: string, moveCamera?: boolean) => void;
  origin: () => { x: number; y: number };
  autoSubmitText?: string | null;
  autoSubmitRequestId?: string | null;
}) {
  const draft = useShotQueueDraft(editor, persistenceKey, autoSubmitText);
  const { raw, setRaw, pageId, setExternalRaw } = draft;
  const [queue, setQueue] = useState<ShotQueue | null>(null);
  const [message, setMessage] = useState("");
  const [messageAt, setMessageAt] = useState("");
  useEffect(() => { setMessageAt(message ? new Date().toLocaleTimeString() : ""); }, [message]);
  // 「改好了、还没入队」这类只是告知的话：几秒后淡出（lib/shot-card-view-rules.ts NOT_QUEUED，CSS .ff-fade-note），
  // 别的消息（报错、拦截、进度）照旧一直留着。
  const [softMessage, setSoftMessage] = useState("");
  const say = (text: string) => { setMessage(text); setSoftMessage(text); };
  useEffect(() => { if (!softMessage || softMessage !== message) return; const timer = window.setTimeout(() => setMessage((now) => now === softMessage ? "" : now), SOFT_MESSAGE_MS); return () => window.clearTimeout(timer); }, [softMessage, message]);
  const [autoStart, setAutoStart] = useState(false);
  // 「JSON / 进度」抽屉：卡片顶栏的按钮开关；没有队列时总是开着。换队列（卡片自己的输入框）时让开。
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [replacing, setReplacing] = useState(false);
  useEffect(() => { setQueue(null); setAutoStart(false); setMessage(""); setDrawerOpen(false); }, [pageId]);
  const panel = useRef<HTMLElement>(null);
  const hasQueue = useRef(false); hasQueue.current = Boolean(queue);
  useEffect(() => {
    // The owner stays mounted while hidden: Escape must not steal other panels' keys.
    const onKey = (event: KeyboardEvent) => {
      // Only while the drawer is on screen, and not while an in-page question or a card popup is open.
      if (event.key !== "Escape" || event.isComposing || isTypingTarget(event.target) || !panel.current?.getClientRects().length || document.querySelector('[role="alertdialog"], .rough-cut-panel, .ab-shade, .scv-shade, .sca-shade, .scf-menu')) return;
      event.stopPropagation();
      // With cards: fold the drawer. Empty cards (no queue): close the cards. Never aborts execution or cancels jobs.
      if (hasQueue.current) setDrawerOpen(false); else onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);
  // Presentation-only: hidden drawers must not traverse shapes or reload the catalog.
  // The execution hook below deliberately remains mounted and independent of visibility.
  const scopeKey = useValue("shot queue current-page catalog", () => visible ? JSON.stringify({ pageId: editor.getCurrentPageId(), ...queueCatalogScope(editor.getCurrentPageShapes()) }) : "", [editor, visible]);
  const [loadedCatalog, setLoadedCatalog] = useState<{ scopeKey: string; roles: { id: string; name: string; ready: boolean }[]; images: { id: string; name: string }[] }>({ scopeKey: "", roles: [], images: [] });
  const catalog = scopeKey && loadedCatalog.scopeKey === scopeKey ? loadedCatalog : { roles: [], images: [] };
  useEffect(() => {
    if (!scopeKey) return;
    let active = true;
    const scope = JSON.parse(scopeKey) as ReturnType<typeof queueCatalogScope>;
    void Promise.all([listRoles(), listAssets("image")]).then(([roles, images]) => {
      if (active) setLoadedCatalog({ scopeKey, ...buildQueueCatalog(scope, roles, images) });
    }).catch(() => { if (active) setMessage("当前画布角色或素材列表读取失败"); });
    return () => { active = false; };
  }, [scopeKey]);
  useEffect(() => {
    if (!autoSubmitText || !draft.isExternalTarget(autoSubmitText)) return;
    let cancelled = false;
    const host = window as Window & { __ffShotQueueBoot?: { status: "loading" | "ready" | "error"; error?: string; promise: Promise<void> } };
    if (!host.__ffShotQueueBoot) {
      let parsed: ShotQueue;
      try { parsed = parseShotQueue(autoSubmitText); }
      catch (error) {
        queueMicrotask(() => { if (!cancelled) setMessage(error instanceof Error ? error.message : "镜头表无法读取"); });
        return;
      }
      const inbox = matchingInboxRequest(pageId, parsed);
      if (inbox?.phase === "blocked") return;
      host.__ffShotQueueBoot = { status: "loading", promise: (async () => {
        // Inbox has its own durable receipt + cross-tab scheduler lock. Do not reset/use the old global claim gate.
        if (!inbox) { const instance = await loadFrameflowInstance(); const claim = await fetch(`http://127.0.0.1:${instance.claimPort}/claim`, { cache: "no-store" }); if ((await claim.text()).trim() !== "ok") throw new Error("提交已在另一个画布页开始"); }
        await ensureQueuePrimaries(parsed);
      })().then(() => { host.__ffShotQueueBoot!.status = "ready"; }).catch((error: unknown) => {
        host.__ffShotQueueBoot!.status = "error";
        host.__ffShotQueueBoot!.error = error instanceof Error ? error.message : "无法准备角色主外观";
        reportInboxRequest(pageId, parsed, "blocked", { error: host.__ffShotQueueBoot!.error });
      }) };
    }
    void host.__ffShotQueueBoot.promise.then(() => {
      if (cancelled) return;
      const boot = host.__ffShotQueueBoot;
      if (!boot || boot.status === "error") { setExternalRaw(autoSubmitText); setMessage(boot?.error ?? "无法准备角色主外观"); return; }
      if (!draft.isUneditedExternal(autoSubmitText)) { const error = "准备外部队列期间文本已修改，已暂停自动入队，请手动检查镜头表"; setMessage(error); reportInboxRequest(pageId, parseShotQueue(autoSubmitText), "blocked", { error }); return; }
      try {
        const parsed = parseShotQueue(autoSubmitText);
        if (matchingInboxRequest(pageId, parsed)?.phase === "blocked") return;
        setExternalRaw(autoSubmitText);
        setQueue(parsed);
        setMessage("已载入镜头表，开始按章节提交。");
        setAutoStart(true);
        setDrawerOpen(true); // show the progress
      } catch (error) {
        setMessage(error instanceof Error ? error.message : "镜头表无法读取");
      }
    });
    return () => { cancelled = true; };
  }, [autoSubmitText, pageId, autoSubmitRequestId]);
  const execution = useShotQueueExecution({
    editor, queue, restore: (saved) => {
      let restored = draft.restoreSession(shotQueueJson(saved).trimEnd());
      if (!restored) { try { restored = JSON.stringify(parseShotQueue(draft.currentRaw())) === JSON.stringify(saved); } catch { /* Preserve incomplete manual text. */ } }
      if (restored) setQueue(saved);
      return restored;
    },
    message: setMessage, createNode, focusNode, origin, persistenceKey, drawerOpen: visible && drawerOpen,
  });
  const { rows, setRows, busyChapter, runningAll, submit, submitAll } = execution;
  // 卡片锁：提交循环真的在跑，或本批没停且 ComfyUI 里真有排队/生成的镜头。「状态待确认」不再锁（2026-11-12：循环早退出了，卡片还一直「排队中 1/28」）。
  const lock = queueLockState(rows, busyChapter !== null, execution.stoppedAt !== null);
  // 停止：先打开抽屉，停完的那句话（停了几镜、ComfyUI 里还有没有本批）就在用户眼前。
  const stopQueue = () => { setDrawerOpen(true); void execution.stop(); };
  const forceUnlock = async () => { if (await askConfirm({ title: "强制解锁？", message: FORCE_UNLOCK_NOTE, confirmLabel: "强制解锁" })) { setDrawerOpen(true); execution.forceUnlock(); } };
  // Manual 入队 asks first (in the page, never window.confirm: that would freeze the inbox heartbeat).
  const [startAsk, setStartAsk] = useState<{ plan: BatchStartPlan; chapter?: number } | null>(null);
  // 防重复：从点下去到这一批提交完一直锁着。卡片顶栏「全部入队」、章节「本章入队」和这里的按钮都走 startManual / startGo，
  // 同一把锁（submit 自己的锁要等 h3q 五项检查跑完才设上，快速连点两下会漏过去）。
  const startLock = useRef(false);
  const [checking, setChecking] = useState(false);
  const cancelAsk = () => { setStartAsk(null); setMessage("已取消，没有提交。"); };
  // 页面正中的入队确认框：Esc = 取消（不提交）。
  useEffect(() => {
    if (!startAsk) return;
    const onAskKey = (event: KeyboardEvent) => { if (event.key !== "Escape" || event.isComposing) return; event.stopPropagation(); event.preventDefault(); setStartAsk(null); setMessage("已取消，没有提交。"); };
    window.addEventListener("keydown", onAskKey, true);
    return () => window.removeEventListener("keydown", onAskKey, true);
  }, [startAsk]);
  const DUPLICATE = "刚才那次入队还在盘点 / 提交，这一下没有重复提交";
  const startGo = (chapter: number | undefined, reuse?: "skip" | "rerender") => {
    setStartAsk(null);
    if (startLock.current) { setMessage(DUPLICATE); return; }
    startLock.current = true;
    setDrawerOpen(true); // 确认后打开「JSON / 进度」看每一镜进度和画面五项拦截原因
    setMessage("已确认，正在检查队列…");
    void (chapter === undefined ? submitAll(true, reuse) : submit(chapter, true, reuse)).finally(() => { startLock.current = false; });
  };
  const startManual = async (chapter?: number) => {
    if (startLock.current) { setMessage(DUPLICATE); return; }
    startLock.current = true; setChecking(true);
    setMessage("已点击，正在盘点画布上已有的镜头…");
    let plan: BatchStartPlan | null;
    try { plan = await execution.previewStart(chapter); } catch (error) { startLock.current = false; setChecking(false); setDrawerOpen(true); setMessage(`入队前盘点失败，未提交：${error instanceof Error ? error.message : String(error)}`); return; }
    startLock.current = false; setChecking(false);
    // A different queue text than this page's last batch (edited, pasted back, other queue) starts a NEW batch: always ask.
    if (plan && plan.newBatch) { setMessage(""); setStartAsk({ plan, chapter }); return; }
    startGo(chapter);
  };
  // 修改历史：每份队列（按标题）最近 20 版。Every validated queue text is recorded; undo / redo put an older text back.
  const historyStore = useMemo(() => new QueueHistoryStore({ get: (key) => getMeta<QueueHistory>(key), put: (key, value) => putMeta(key, value) }), []);
  const [historyView, setHistoryView] = useState<{ title: string; history: QueueHistory } | null>(null);
  const restoringHistory = useRef(false);
  const rawNow = useRef(raw); rawNow.current = raw;
  useEffect(() => {
    if (!queue) return;
    const title = queue.title;
    const done = (history: QueueHistory) => setHistoryView({ title, history });
    if (restoringHistory.current) { restoringHistory.current = false; void historyStore.state(title).then(done).catch(() => {}); return; }
    if (rawNow.current.trim()) void historyStore.record(title, rawNow.current).then(done).catch(() => {});
  }, [queue, historyStore]);
  const stepHistory = async (delta: -1 | 1) => {
    if (!queue || lock.locked) { setMessage("队列正在提交，先停止再撤销"); return; }
    const title = queue.title;
    const moved = await historyStore.step(title, delta).catch(() => null);
    if (!moved) { setMessage(delta < 0 ? "没有更早的版本了" : "没有可以恢复的版本了"); return; }
    try {
      const parsed = parseShotQueue(moved.text);
      restoringHistory.current = true;
      setRaw(moved.text); setQueue(parsed); setHistoryView({ title, history: moved.history });
      say(`${parsed.title}：已${delta < 0 ? "撤销" : "恢复"}到第 ${moved.history.index + 1}/${moved.history.versions.length} 版，${NOT_QUEUED}`);
    } catch (error) {
      await historyStore.step(title, delta === -1 ? 1 : -1).catch(() => null);
      setMessage(`那一版现在通不过检查，没有换：${error instanceof Error ? error.message : "镜头表无法读取"}`);
    }
  };
  const history = queue && historyView?.title === queue.title ? historyView.history : null;
  // 收件箱来的 *_cards.json：正在改别的队列时不直接覆盖，先放提示条，由用户点「切换」。
  const [incoming, setIncoming] = useState<{ text: string; file: string }[]>([]);
  const [incomingHidden, setIncomingHidden] = useState(false);
  const loadIncoming = (text: string, file: string) => {
    setRaw(text); setRows({});
    try { const next = parseShotQueue(text); setQueue(next); say(`收件箱「${file}」已放进镜头卡片，检查通过，${NOT_QUEUED}`); }
    catch (error) { setQueue(null); setMessage(`收件箱「${file}」已放进镜头卡片，但还有问题：${error instanceof Error ? error.message : "镜头表无法读取"}`); }
    showCards();
  };
  const switchIncoming = () => {
    const next = incoming[incoming.length - 1];
    if (!next) return;
    if (lock.locked) { setMessage("正在提交别的队列，等它结束再切换"); return; }
    // The text being replaced is already in its history if it passed the check; keep unchecked text too.
    if (!queue && raw.trim()) void historyStore.record("（未通过检查的文本）", raw).catch(() => {});
    setIncoming((list) => list.filter((item) => item !== next)); setIncomingHidden(false);
    loadIncoming(next.text, next.file);
  };
  const keyOf = (chapter: number, shot: number) => `${chapter}:${shot}`;
  const removeShot = async (chapterIndex: number, shotIndex: number) => {
    if (!queue || busyChapter !== null) return;
    const removed = queue.chapters[chapterIndex]?.shots[shotIndex];
    if (!removed) return;
    const chapters: ShotQueue["chapters"] = [];
    const nextRows: typeof rows = {};
    queue.chapters.forEach((chapter, oldChapterIndex) => {
      const shots = chapter.shots.filter((_, index) => oldChapterIndex !== chapterIndex || index !== shotIndex);
      if (!shots.length) return;
      const newChapterIndex = chapters.length;
      let newShotIndex = 0;
      chapter.shots.forEach((_, oldShotIndex) => {
        if (oldChapterIndex === chapterIndex && oldShotIndex === shotIndex) return;
        const row = rows[keyOf(oldChapterIndex, oldShotIndex)];
        if (row) nextRows[keyOf(newChapterIndex, newShotIndex)] = row;
        newShotIndex++;
      });
      chapters.push({ ...chapter, shots });
    });
    const next = chapters.length ? { ...queue, chapters } : null;
    try { await execution.removeEntry(chapterIndex, shotIndex, next); }
    catch (cause) { setMessage(cause instanceof Error ? cause.message : "删除队列记录失败"); return; }
    setQueue(next);
    setRaw(next ? shotQueueJson(next) : "");
    setRows(nextRows);
    setMessage(`已从队列删除「${removed.title}」。画布节点和已生成文件保留。${next ? "" : "队列已清空。"}`);
  };
  const check = (source = raw) => {
    try {
      const next = parseShotQueue(source);
      setQueue(next);
      setRows({});
      say(`${next.title}：${next.chapters.length} 章，${next.chapters.reduce((sum, chapter) => sum + chapter.shots.length, 0)} 镜。检查通过，${NOT_QUEUED}`);
    } catch (error) {
      setQueue(null);
      setMessage(error instanceof SyntaxError ? "镜头表不是合法 JSON" : error instanceof Error ? error.message : "镜头表无法读取");
    }
  };

  // Top-bar「卡片」: the canvas shows the board; here parse the pasted text if not checked yet.
  const cardSource = useRef({ queue, raw }); cardSource.current = { queue, raw };
  const loadIncomingRef = useRef(loadIncoming); loadIncomingRef.current = loadIncoming;
  const cardBusy = useRef(false); cardBusy.current = lock.locked;
  useEffect(() => {
    const open = () => {
      const { queue: current, raw: text } = cardSource.current;
      if (current) return;
      // Nothing pasted yet, or not valid: the board opens empty with the「JSON / 进度」drawer.
      if (text.trim()) { try { setQueue(parseShotQueue(text)); setRows({}); } catch { /* the drawer shows the text and the problem on 检查 */ } }
    };
    window.addEventListener("frameflow-open-shot-cards", open);
    // 命令面板「镜头卡片 · JSON / 进度」：打开卡片并展开抽屉。
    const openDrawer = () => { open(); setDrawerOpen(true); };
    window.addEventListener("frameflow-open-queue-drawer", openDrawer);
    // 收件箱 *_cards.json: load into this panel and open the cards. Never submits; refuses while a queue is being submitted.
    const fromInbox = (event: Event) => {
      const { text, file, reply } = (event as CustomEvent<{ text: string; file: string; reply: (problem: string | null) => void }>).detail;
      if (cardBusy.current) { reply("卡片正在提交别的队列，等它结束"); return; }
      const current = cardSource.current.raw;
      if (!current.trim() || current === text) { loadIncomingRef.current(text, file); reply(null); return; }
      // Something else is open (maybe with unsaved card edits): never overwrite it, offer a switch.
      setIncoming((list) => [...list.filter((item) => item.file !== file), { text, file }]); setIncomingHidden(false);
      setMessage(`收件箱来了新队列「${file}」。你正在看的队列没有被换掉；要换请点「切换到新队列」。`);
      showCards(); reply(null);
    };
    window.addEventListener("frameflow-inbox-cards", fromInbox);
    return () => { window.removeEventListener("frameflow-open-shot-cards", open); window.removeEventListener("frameflow-open-queue-drawer", openDrawer); window.removeEventListener("frameflow-inbox-cards", fromInbox); };
  }, [setRows]);
  // 顶栏「卡片」小红点：收件箱有新队列等着切换（卡片关着时显示）。
  useEffect(() => { window.dispatchEvent(new CustomEvent("frameflow-cards-incoming", { detail: incoming.length })); }, [incoming.length]);

  useEffect(() => {
    if (!autoStart || !queue || !execution.ready) return;
    if (matchingInboxRequest(pageId, queue)?.phase === "blocked") return;
    const host = window as Window & { __ffShotQueueRun?: boolean };
    if (host.__ffShotQueueRun) return;
    host.__ffShotQueueRun = true;
    void submitAll();
  }, [autoStart, queue, execution.ready, submitAll, pageId]);

  const submitting = lock.locked;
  // 卡片顶栏「全部入队（N 镜）」/「继续未完成」/「排队中 3/26」和章节「本章入队」：和抽屉里的按钮同一个 startManual。
  const totalShots = queue ? queue.chapters.reduce((sum, chapter) => sum + chapter.shots.length, 0) : 0;
  const doneShots = Object.values(rows).filter((row) => row?.status === "completed").length;
  const enqueuedBefore = Object.keys(rows).length > 0;
  const enqueue = {
    label: enqueueLabel({ checking, asking: startAsk !== null, submitting, done: doneShots, total: totalShots, enqueuedBefore }),
    title: !execution.ready ? "队列记录还没读完（一直这样请刷新页面）" : submitting ? "正在排队：点一下打开「JSON / 进度」看每一镜的进度" : startAsk ? "入队前要你确认：看页面中间的确认框" : "点了先在页面中间问你（新的一批）；画面五项不过的镜头会拦住并写明缺哪一项，要你人工放行",
    disabled: !execution.ready, running: submitting,
    all: () => { if (submitting) setDrawerOpen(true); else if (!startAsk && !checking) void startManual(); },
    chapter: (index: number) => { if (!submitting && !startAsk && !checking) void startManual(index); },
    chapterBusy: submitting || checking || startAsk !== null || !execution.ready,
    stop: submitting || execution.stuck ? stopQueue : undefined,
    stopping: execution.stopping,
    forceUnlock: execution.stuck ? () => void forceUnlock() : undefined,
  };
  const drawerShown = visible && !replacing && (drawerOpen || !queue);
  // The execution owner above must survive display errors and retry. Never move this boundary around the hook.
  return <CanvasPanelBoundary name="镜头卡片 · JSON / 进度" onClose={onClose}><GuardedPanelRender render={() => <>
    {visible && <CanvasPanelBoundary name="镜头卡片" onClose={onClose}><ShotCardBoard queue={queue} statuses={Object.fromEntries(Object.entries(rows).map(([key, row]) => [key, row ? statusText[row.status] : undefined]))} nodeIds={Object.fromEntries(Object.entries(rows).flatMap(([key, row]) => row?.nodeId ? [[key, row.nodeId]] : []))} onClose={onClose}
      locked={submitting ? "队列正在提交，先在「JSON / 进度」里点「停止后续排队」，再改" : ""}
      queueDrawer={{ open: drawerShown, toggle: () => setDrawerOpen((open) => !open), busy: submitting, onReplacing: setReplacing, enqueue }}
      history={history ? { label: `第 ${history.index + 1}/${history.versions.length} 版`, canUndo: canUndo(history), canRedo: canRedo(history), undo: () => void stepHistory(-1), redo: () => void stepHistory(1) } : undefined}
      exportJson={() => downloadQueueJson(queue?.title ?? "镜头队列", raw)}
      incoming={incoming.length ? { file: incoming[incoming.length - 1].file, count: incoming.length, hidden: incomingHidden, switchTo: switchIncoming, later: () => setIncomingHidden(true) } : undefined}
      canvas={{
        pageShots: () => editor.getCurrentPageShapes().filter((shape) => shape.type === "h3-node").flatMap((shape) => { const p = shape.props as { shotTitle?: string; prompt?: string; shotId?: string }; return p.shotTitle && p.shotId ? [{ nodeId: shape.id, title: p.shotTitle, prompt: p.prompt ?? "", shotId: p.shotId }] : []; }),
        createNode: (props) => createNode(props as CreateProps, origin()),
        focus: focusNode,
      }}
      onLoad={(text) => {
        try { const next = parseShotQueue(text); setRaw(text); setQueue(next); setRows({}); say(`${next.title}：从镜头卡片载入，检查通过，${NOT_QUEUED}`); return null; }
        catch (error) { return error instanceof SyntaxError ? `不是合法 JSON：${error.message}` : error instanceof Error ? error.message : "镜头表无法读取"; }
      }}
      onChange={(next) => {
        // Card edits rewrite the queue text: the same JSON the 入队 buttons submit. Validated before it is kept.
        try { const text = shotQueueJson(next); const parsed = parseShotQueue(text); setRaw(text); setQueue(parsed); say(`${parsed.title}：已改好，${NOT_QUEUED}`); return null; }
        catch (error) { return error instanceof Error ? error.message : "修改后的镜头表无法通过检查"; }
      }} /></CanvasPanelBoundary>}
    {drawerShown && createPortal(<aside ref={panel} className="sc-queue-drawer" role="dialog" aria-label="JSON / 进度" onPointerDown={(event) => event.stopPropagation()} onWheel={(event) => event.stopPropagation()}>
    <header><div><small>原「队列」面板 · H3 · 全部节点预建 · ComfyUI 顺序排队</small><h2>JSON / 进度</h2></div>{queue ? <button type="button" aria-label="收起 JSON / 进度" title="收起（Esc）；排队照常进行" onClick={() => setDrawerOpen(false)}><X size={17} /></button> : <button type="button" aria-label="关闭镜头卡片" onClick={onClose}><X size={17} /></button>}</header>
    <div className="shot-queue-body">
    <details className="id-catalog" key={scopeKey ? JSON.parse(scopeKey).pageId : "hidden"}>
      <summary>当前画布角色和图片 ID</summary>
      <ul>{catalog.roles.map((role) => <li key={role.id}><button type="button" onClick={() => { void copyPlainText(role.id).then((ok) => setMessage(ok ? `已复制 ${role.name} 的 roleId` : "复制失败，请手动选择 roleId")); }}><b>{role.name}{role.ready ? "" : "（缺主外观）"}</b><code>{role.id}</code><span>复制</span></button></li>)}{!catalog.roles.length && <li>当前画布没有关联角色</li>}</ul>
      <ul>{catalog.images.map((image) => <li key={image.id}><button type="button" onClick={() => { void copyPlainText(image.id).then((ok) => setMessage(ok ? `已复制 ${image.name} 的 Asset ID` : "复制失败，请手动选择 Asset ID")); }}><b>{image.name}</b><code>{image.id}</code><span>复制</span></button></li>)}{!catalog.images.length && <li>当前画布没有图片</li>}</ul>
    </details>
    <label className="autopilot-field"><span>镜头表 JSON</span><textarea rows={8} disabled={busyChapter !== null} value={raw} spellCheck={false} onChange={(event) => { setRaw(event.target.value); setQueue(null); }} placeholder='{"version":"shot-queue-v1", ...}' /></label>
    <div className="reference-actions">
      <button type="button" title={queue ? "导出当前队列每一镜的标题、时长、提示词和台词" : "还没载入队列：导出当前画布上所有 H3 镜头（从左到右）"} onClick={async () => {
        if (queue) { downloadShotList(queue.title+"-队列台词清单",queue.chapters.flatMap(chapter=>chapter.shots)); setMessage(`已导出队列「${queue.title}」的台词清单`); return; }
        try {
          const nodes=editor.getCurrentPageShapes().filter(node=>node.type==="h3-node").sort((a,b)=>a.x-b.x || a.y-b.y);
          const shots=await listShots();
          const entries=nodes.map(node=>{ const p=node.props as unknown as {shotTitle?:string;shotId?:string;duration:string;prompt:string;dialogueLines?:{text:string}[]}; const shot=shots.find(item=>item.shotId===p.shotId); return {title:p.shotTitle || shot?.title || (shot ? `镜头${shot.shotNumber}` : node.id),seconds:Number.parseFloat(p.duration),prompt:p.prompt,dialogue:p.dialogueLines}; });
          if (!entries.length) {setMessage("当前画布没有 H3 镜头");return;}
          downloadShotList("当前画布镜头台词清单",entries);setMessage(`已导出当前画布 ${entries.length} 个镜头（从左到右）`);
        } catch(cause) {setMessage(cause instanceof Error?cause.message:"导出失败");}
      }}>导出台词清单</button>
      {incoming.length > 0 && <button type="button" disabled={lock.locked} onClick={switchIncoming}>切换到收件箱新队列「{incoming[incoming.length - 1].file}」</button>}
      <button type="button" className={queue ? "" : "is-primary"} onClick={() => check()} disabled={!execution.ready || !raw.trim() || busyChapter !== null}>检查镜头表</button>
      <button type="button" disabled={busyChapter !== null} onClick={() => { const sample = `${JSON.stringify(shotQueueExample(), null, 2)}\n`; setRaw(sample); setQueue(null); setMessage("已填入示例。把 roleId 和场景图 assetId 换成你自己的，再检查。"); }}>填入示例</button>
      <button type="button" disabled={lock.locked} onClick={async () => { if (raw.trim() && !await askConfirm('用格式示例替换当前镜头表文本？已有节点和视频保留。')) return; if (cardBusy.current) { setMessage("队列正在提交，没有替换镜头表"); return; } setRaw(`${JSON.stringify(shotQueueFrameExample(),null,2)}\n`); setQueue(null); setMessage('已填入两阶段首尾帧格式示例，尚未提交。请替换占位角色、场景和每段提示词，再检查；每段独立输出。'); }}>填入首尾帧示例</button>
      <label className="ff-file-button" aria-disabled={busyChapter !== null}>载入 JSON 文件<input aria-label="载入镜头表文件" type="file" accept=".json,application/json" hidden disabled={busyChapter !== null} onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ""; if (!file) return; if (file.size > 1_500_000) { setMessage("镜头表文件过大"); return; } void file.text().then((text) => { setRaw(text); check(text); }).catch(()=>setMessage("文件读取失败")); }} /></label>
      {(lock.locked || execution.stuck) && <button type="button" disabled={execution.stopping} onClick={stopQueue}>{execution.stopping ? "正在停止…" : "停止后续排队（保留正在执行的镜头）"}</button>}
      {execution.stuck && <button type="button" title={FORCE_UNLOCK_NOTE} onClick={() => void forceUnlock()}>强制解锁</button>}
      {!lock.locked && lock.unconfirmed > 0 && <p className="ff-hint backup-note">有 {lock.unconfirmed} 镜「任务状态待确认」：提交循环已经退出，卡片不锁；这几镜不会自动重提，先核实再决定要不要重渲。</p>}
      {queue && execution.failedCount > 0 && <button type="button" disabled={!execution.ready || busyChapter !== null} onClick={() => void execution.retryFailed()}>重试失败镜头（{execution.failedCount}）</button>}
    </div>
    {message && <p key={messageAt + message} role="status" className={`backup-note ${message === softMessage ? "ff-fade-note" : ""}`}>{message}</p>}
    {!queue && busyChapter === null && <p className="ff-hint backup-note">新队列请在上方选择 JSON 文件，或粘贴后点击「检查镜头表」，检查通过后左边出现每一镜的卡片，再点这里的「全部镜头入队」。旧失败记录不会占用新队列；已删除的镜头不会恢复。</p>}
    {queue && <label className="backup-note"><input type="checkbox" disabled={lock.locked || execution.failedCount > 0 || Object.keys(rows).length > 0} checked={queue.defaults?.noBackgroundMusic ?? false} onChange={event=>{
      const next={...queue,defaults:{...queue.defaults,noBackgroundMusic:event.target.checked}};
      setQueue(next);setRaw(JSON.stringify(next,null,2));
    }} />禁止背景音乐（新导入队列；已建节点请在各节点修改）</label>}
    {queue && <label className="backup-note" title="每条出片完成后自动排一次去配乐（CDX23，只留台词和音效），结果是新版本，原声版保留。单镜可在 JSON 里写 autoRemoveMusic 覆盖；只影响之后的出片"><input type="checkbox" disabled={lock.locked || execution.failedCount > 0 || Object.keys(rows).length > 0} checked={queue.defaults?.autoRemoveMusic ?? true} onChange={event=>{
      const next={...queue,defaults:{...queue.defaults,autoRemoveMusic:event.target.checked}};
      setQueue(next);setRaw(JSON.stringify(next,null,2));
    }} />出片后自动去配乐（默认开；单镜可覆盖；已建节点请在各节点修改）</label>}
    {queue && (() => { const est = queueEstimate(queue, (c, s) => rows[keyOf(c, s)]?.status === "completed"); return <p className="ff-hint backup-note" title={ESTIMATE_NOTE}>⏱ 预计耗时（估算）：全部 {est.shots} 镜{formatEstimate(est.total)}{est.left < est.shots ? `，还剩 ${est.left} 镜${formatEstimate(est.remaining)}` : ""}。按本机实测估（10 步约 140 秒一镜，理解优先 211–321 秒），不含排队和尾帧高清等后处理。</p>; })()}
    {queue && <QueueCheckupList warnings={shotQueueWarnings(queue)} />}
    {queue?.chapters.some(chapter => chapter.shots.some(shot => shot.firstFrameFrom || shot.lastFrameFrom)) && <p className="ff-hint backup-note">两阶段：先完成主镜头，来源渲完后自动截帧并提交续段。离开或刷新本页会暂停；回到本页会接着提交尚未入队的续段，不会重提已入队的镜头。每段独立输出，不自动合并。首尾帧＋参考为实验链路，生成效果需人工验收。</p>}
    {queue && <div className="shot-queue-submit-all"><button type="button" disabled={!execution.ready || busyChapter !== null || startAsk !== null} onClick={() => void startManual()}>{runningAll ? "正在依次入队" : "全部镜头入队／继续未完成"}</button>{!execution.ready ? <p className="backup-note" style={{ margin: "6px 0 0" }}>按钮暂不可用：队列记录还没读完（一直这样请刷新页面）</p> : busyChapter !== null ? <p className="backup-note" style={{ margin: "6px 0 0" }}>按钮暂不可用：{runningAll ? "正在依次入队" : `第 ${busyChapter + 1} 章正在提交或等待续段来源`}；要中断请点上方「停止后续排队」</p> : null}{message && <p key={messageAt + message} className={`backup-note ${message === softMessage ? "ff-fade-note" : ""}`} role="status" style={{ margin: "6px 0 0" }}>{messageAt ? `${messageAt} · ` : ""}{message}</p>}</div>}
    <InboxControlBar embedded />
    {queue && <ol className="autopilot-plan">{queue.chapters.map((chapter, chapterIndex) => <li key={`${chapter.title}-${chapterIndex}`}>
      <header><b>{chapterIndex + 1}. {chapter.title}</b><span>{chapter.shots.length} 镜</span></header>
      <ol>{chapter.shots.map((shot, shotIndex) => {
        const row = rows[keyOf(chapterIndex, shotIndex)];
        const frameDescription = queueFrameDescription(shot);
        const rowNodeId = row?.nodeId && editor.getShape(row.nodeId as TLShape["id"]) ? row.nodeId : undefined;
        const existingNodeId = rowNodeId ?? editor.getCurrentPageShapes().find((shape) => shape.type === "h3-node" && (shape.props as { shotTitle?: string }).shotTitle === shot.title)?.id;
        return <li className="shot-queue-shot" key={`${shot.title}-${shotIndex}`}><div><b>{shotIndex + 1}. {shot.title}</b><span> · {shot.seconds} 秒 · {shot.aspect} · {shotQueueMegapixels(shot, queue?.defaults).toFixed(2)}MP · 角色 {shot.roleIds.length} · 场景 {shot.sceneAssetIds.length}{row ? ` · ${statusText[row.status]}` : ""}</span>{frameDescription && <small>第二阶段 · {frameDescription} · 独立片段</small>}{row?.detail ? <small> {row.detail}</small> : null}</div><span style={{ display: "inline-flex", alignItems: "center", gap: 4, flexShrink: 0 }}>{existingNodeId && <button type="button" className="shot-queue-delete" aria-label={`定位镜头 ${shotIndex + 1}：${shot.title}`} title="在画布上定位并选中这个镜头节点" style={{ display: "inline-flex", alignItems: "center", gap: 3 }} onClick={() => { onClose(); focusNode(existingNodeId, true); }}><Crosshair size={12} aria-hidden="true" />定位</button>}<button type="button" className="shot-queue-delete" aria-label={`删除镜头 ${shotIndex + 1}：${shot.title}`} title={busyChapter !== null ? "请先停止队列，当前镜头结束后可删除" : "只从队列移除，保留画布节点和文件"} disabled={busyChapter !== null} onClick={() => void removeShot(chapterIndex, shotIndex)}>删除</button></span></li>;
      })}</ol>
      <button type="button" disabled={!execution.ready || busyChapter !== null} onClick={() => void startManual(chapterIndex)}>{busyChapter === chapterIndex ? "正在提交本章" : "本章入队／继续未完成"}</button>
    </li>)}</ol>}
    </div>
  </aside>, document.body)}
    {queue && startAsk && createPortal(<div className="sq-ask-shade" style={ASK_SHADE} onPointerDown={(event) => { event.stopPropagation(); if (event.target === event.currentTarget) cancelAsk(); }} onWheel={(event) => event.stopPropagation()}>{(() => { const { plan, chapter } = startAsk; const done = plan.reusable.filter((item) => item.state === "done").length; const busy = plan.reusable.length - done; const names = plan.reusable.slice(0, 6).map((item) => item.title).join("、") + (plan.reusable.length > 6 ? ` 等 ${plan.reusable.length} 镜` : ""); return <div className="shot-queue-confirm sq-ask" style={ASK_PANEL} role="alertdialog" aria-modal="true" aria-label="入队前确认">
      <p><b>{chapter === undefined ? "全部镜头入队" : `第 ${chapter + 1} 章入队`}：会新建一批，共 {plan.total} 镜</b></p>
      <p>镜头表和本页上次入队的不一样（改过文字、贴回了旧队列，或换了队列），所以不是「继续上一批」。不跳过的话，每一镜都会新建节点、重新渲染。</p>
      {(() => { const inScope = (c: number) => chapter === undefined || c === chapter; const skipTitles = new Set(plan.reusable.map((item) => item.title)); const all = queueEstimate(queue, undefined, inScope); const skipped = queueEstimate(queue, (c, s) => skipTitles.has(queue.chapters[c].shots[s].title), inScope); return <p title={ESTIMATE_NOTE}>预计耗时（估算）：全部渲染{formatEstimate(all.total)}{plan.reusable.length > 0 ? `；跳过已有的、只渲染 ${skipped.left} 镜${formatEstimate(skipped.remaining)}` : ""}。</p>; })()}
      {plan.reusable.length > 0 && <p>画布上已有 {plan.reusable.length} 镜是同标题、同提示词{done ? `，${done} 镜已出片` : ""}{busy ? `，${busy} 镜正在渲染` : ""}：{names}。</p>}
      <div className="shot-queue-confirm-actions">
        {plan.reusable.length > 0 && <button type="button" onClick={() => startGo(chapter, "skip")}>跳过这 {plan.reusable.length} 镜，只渲染其余 {plan.total - plan.reusable.length} 镜</button>}
        <button type="button" onClick={() => startGo(chapter, "rerender")}>{plan.reusable.length > 0 ? `全部再出一条（渲染 ${plan.total} 镜，跳过 0 镜）` : `新建一批，渲染 ${plan.total} 镜`}</button>
        <button type="button" autoFocus onClick={cancelAsk}>取消（不提交）</button>
      </div>
    </div>; })()}</div>, document.body)}
  </>} /></CanvasPanelBoundary>;
}
