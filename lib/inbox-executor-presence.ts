/**
 * Which open canvas page picks up inbox work. The scheduler takes a short cross-tab lock each
 * tick (navigator.locks "frameflow-inbox-scheduler-v2", ifAvailable), so with several canvas pages
 * open any of them may hand a new _queue.json to its own queue panel. This module only OBSERVES
 * that — it never changes who runs.
 */
export const PRESENCE_CHANNEL = "frameflow-canvas-presence-v1";
/** A page that has not announced itself for this long is treated as closed. */
export const PRESENCE_TIMEOUT_MS = 12_000;
/** "Recently picked up inbox work". The scheduler ticks every 4 s. */
export const RECENT_TICK_MS = 15_000;

export type PresenceBeat = { tabId: string; at: number; lastTickAt: number | null };
export type ExecutorView = { kind: "only" | "shared"; label: string; detail: string; pages: number };

export function executorView(self: PresenceBeat, peers: readonly PresenceBeat[], now: number): ExecutorView {
  const alive = peers.filter((peer) => peer.tabId !== self.tabId && now - peer.at <= PRESENCE_TIMEOUT_MS);
  const recent = (beat: PresenceBeat) => beat.lastTickAt !== null && now - beat.lastTickAt <= RECENT_TICK_MS;
  if (!alive.length) return { kind: "only", label: "本页是执行页", detail: recent(self) ? "只开着这一个画布页，收件箱的新队列由本页接手。" : "只开着这一个画布页。收件箱扫描还没在本页跑起来（刚打开，或浏览器不支持跨标签锁）。", pages: 1 };
  const pages = alive.length + 1;
  const others = alive.filter(recent).length;
  const mine = recent(self);
  const who = mine && others ? `本页和另外 ${others} 页最近都接过手` : mine ? "最近是本页在接手" : others ? "最近是另一页在接手" : "最近还没有页接手";
  return { kind: "shared", label: `执行页不固定（开着 ${pages} 页）`, detail: `开着 ${pages} 个画布页，收件箱的新队列哪一页接手不固定（${who}）。只留一个画布页最稳，其他的关掉。`, pages };
}

/** Browser side: announce this page and listen to the others. Returns a stop function. */
export function startPresence(onChange: (view: ExecutorView) => void, getLastTick: () => number | null) {
  if (typeof BroadcastChannel === "undefined") { onChange(executorView({ tabId: "self", at: Date.now(), lastTickAt: getLastTick() }, [], Date.now())); return () => {}; }
  const tabId = crypto.randomUUID();
  const peers = new Map<string, PresenceBeat>();
  const channel = new BroadcastChannel(PRESENCE_CHANNEL);
  const self = (): PresenceBeat => ({ tabId, at: Date.now(), lastTickAt: getLastTick() });
  const update = () => onChange(executorView(self(), [...peers.values()], Date.now()));
  channel.onmessage = (event: MessageEvent<PresenceBeat & { bye?: boolean }>) => {
    const beat = event.data; if (!beat || typeof beat.tabId !== "string" || beat.tabId === tabId) return;
    if (beat.bye) peers.delete(beat.tabId); else peers.set(beat.tabId, { tabId: beat.tabId, at: Date.now(), lastTickAt: typeof beat.lastTickAt === "number" ? beat.lastTickAt : null }); // same machine, same clock
    update();
  };
  const beat = () => { try { channel.postMessage(self()); } catch { /* closed */ } update(); };
  const bye = () => { try { channel.postMessage({ ...self(), bye: true }); } catch { /* closed */ } };
  beat(); const timer = setInterval(beat, 4000);
  window.addEventListener("pagehide", bye);
  return () => { clearInterval(timer); window.removeEventListener("pagehide", bye); bye(); channel.close(); };
}

let lastSchedulerTick: number | null = null;
/** Called by the inbox scheduler when THIS page got the scheduler lock for a tick. */
export function noteInboxSchedulerTick(at = Date.now()) { lastSchedulerTick = at; }
export const lastInboxSchedulerTick = () => lastSchedulerTick;
