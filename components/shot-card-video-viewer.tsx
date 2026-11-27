"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { ChevronLeft, ChevronRight, LocateFixed, Play, X } from "lucide-react";
import { acquireMediaUrl, releaseMediaUrl } from "@/lib/local-video-store";
import { getPoster } from "@/lib/poster-cache";
import { isTypingTarget } from "@/lib/keyboard-guards";
import { inPageDialogOpen } from "@/components/in-page-dialog";
import { copyPlainText } from "@/lib/copy-plain-text";
import { clipMiddle, refIds, refNav, refSequence, sameTag, tagVersions, versionStatus, versionTag, viewerKey, viewerNav, viewerSequence, type ViewerRef, type ViewerShot, type ViewerVersion } from "@/lib/shot-card-viewer";

/**
 * 镜头卡片「放大看视频」：卡片里面的一层（不是浏览器全屏），竖屏视频放大到约 88% 可视高度。
 * 左右按钮 / ← → 按镜头切换（每镜一条：视频列当前显示的那条），Esc 或点暗处关闭。
 * 同一时间只放一条：打开时暂停卡片里其他正在放的视频；切走就释放上一条的受管 Object URL。
 */
export type ViewerItem = ViewerVersion & { source: string };
export type ViewerEntry = ViewerShot<ViewerItem> & { aspect: string };

/** 放大层里的去配乐按钮：show(assetId) 只是切过去看，不改「已采用」。 */
export type ViewerDemix = (item: ViewerItem, shot: ViewerEntry, show: (assetId: string) => void) => ReactNode;

export function ShotVideoViewer({ shots, start, onClose, onLocate, demix, aside }: { shots: ViewerEntry[]; start: string; onClose: () => void; onLocate: (key: string) => void; demix?: ViewerDemix; /** 视频旁边的说明栏（文生视频镜头放完整画面描述） */ aside?: (key: string) => ReactNode }) {
  const sequence = viewerSequence(shots);
  const [title, setTitle] = useState(start);
  const [pickedId, setPickedId] = useState<string | null>(null);
  const shot = sequence.find((item) => item.title === title) ?? null;
  const nav = viewerNav(sequence, title);
  const version = shot ? shot.versions.find((item) => item.assetId === pickedId) ?? shot.versions.find((item) => item.assetId === shot.chosenId) ?? null : null;
  const source = version?.source ?? "";

  const [url, setUrl] = useState("");
  const [failed, setFailed] = useState("");
  const [paused, setPaused] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const sound = useRef({ volume: 1, muted: false });

  // One managed URL at a time: acquire for the current source, release when it changes or the viewer closes.
  useEffect(() => {
    if (!source) return;
    let active = true;
    let held: { key: string | null; url: string; revoke: boolean } | null = null;
    setUrl(""); setFailed("");
    void acquireMediaUrl(source).then((media) => {
      if (!active) { releaseMediaUrl(media.key); if (media.revoke) URL.revokeObjectURL(media.url); return; }
      held = media;
      setUrl(media.url);
    }).catch(() => { if (active) setFailed("读不到这条视频（可能已被删掉或移走）"); });
    return () => {
      active = false;
      const video = videoRef.current;
      if (video) { video.pause(); video.removeAttribute("src"); video.load(); }
      if (held) { releaseMediaUrl(held.key); if (held.revoke) URL.revokeObjectURL(held.url); }
    };
  }, [source]);

  // Only one video plays: pause the small tiles in the card while the viewer is open.
  useEffect(() => {
    for (const video of document.querySelectorAll<HTMLVideoElement>(".sc-root video")) if (video !== videoRef.current) video.pause();
  }, [url]);

  const go = (to: string | null) => { if (to) { setTitle(to); setPickedId(null); } };
  useViewerKeys(nav.prev, nav.next, go, onClose);

  if (!shot || !version) return <div className="scv-shade" role="dialog" aria-modal="true" aria-label="放大看视频" onClick={onClose}><p className="scv-empty">这一镜现在没有视频了</p></div>;
  const poster = getPoster(source);
  const ratio = shot.aspect.replace(":", "/");
  const play = () => { const video = videoRef.current; if (video) void video.play().catch(() => setPaused(true)); };

  return <div className="scv-shade" role="dialog" aria-modal="true" aria-label={`放大看视频：${shot.code} ${shot.name}`} onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <SideButton dir="prev" target={nav.prev} go={go} />
    <div className="scv-stage">
      <header className="scv-head">
        <div className="scv-title"><b>{shot.code}</b><span title={shot.title}>{shot.name}</span><small>{nav.index + 1} / {sequence.length}</small></div>
        <div className="scv-state">{versionStatus(version, shot.chosenId)}</div>
        <button type="button" className="scv-close" aria-label="关闭放大（Esc）" title="关闭（Esc）" onClick={onClose}><X size={18} /></button>
      </header>
      <div className={`scv-frame ${version.stale ? "stale" : ""}`}>
        {url ? <video key={url} ref={videoRef} src={url} controls autoPlay playsInline poster={poster || undefined} style={{ aspectRatio: ratio }}
            onLoadedMetadata={(event) => { event.currentTarget.volume = sound.current.volume; event.currentTarget.muted = sound.current.muted; }}
            onVolumeChange={(event) => { sound.current = { volume: event.currentTarget.volume, muted: event.currentTarget.muted }; }}
            onCanPlay={(event) => setPaused(event.currentTarget.paused)} onPlay={() => setPaused(false)} onPause={() => setPaused(true)} />
          : <div className="scv-wait" style={{ aspectRatio: ratio, ...(poster ? { backgroundImage: `url(${poster})` } : {}) }}><span>{failed || "正在读取视频…"}</span></div>}
        {url && paused && <button type="button" className="scv-play" aria-label="播放" onClick={play}><Play size={22} /></button>}
        {(() => { const side = aside?.(shot.key); return side ? <div className="scv-aside">{side}</div> : null; })()}
      </div>
      <footer className="scv-foot">
        {tagVersions(shot.versions).length > 1 && <div className="scv-tags" role="radiogroup" aria-label="看哪一条（不改已采用）">{tagVersions(shot.versions).map((item) => <button type="button" key={item.assetId} role="radio" aria-checked={sameTag(item, version)} className={`${sameTag(item, version) ? "on" : ""} ${item.stale ? "stale" : ""}`} title={`${versionStatus(item, shot.chosenId)}。只是在这里看，不改「已采用」`} onClick={() => setPickedId(item.assetId)}>{versionTag(item, shot.versions)}</button>)}</div>}
        {demix?.(version, shot, setPickedId)}
        <button type="button" className="scv-locate" title="关闭放大，滚动到这一镜" onClick={() => { onClose(); onLocate(shot.key); }}><LocateFixed size={14} />定位到这一镜</button>
      </footer>
    </div>
    <SideButton dir="next" target={nav.next} go={go} />
  </div>;
}

/** ← → 切换、Esc 关闭（卡片自己的 Esc 看到 .scv-shade 会让路）。 */
function useViewerKeys<T>(prev: T | null, next: T | null, go: (to: T | null) => void, onClose: () => void) {
  const state = useRef({ prev, next, go, onClose });
  state.current = { prev, next, go, onClose };
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.isComposing || isTypingTarget(event.target) || inPageDialogOpen()) return;
      const action = viewerKey(event.key);
      if (!action) return;
      event.preventDefault(); event.stopPropagation();
      const now = state.current;
      if (action === "close") now.onClose(); else now.go(action === "prev" ? now.prev : now.next);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);
}

function SideButton<T>({ dir, target, go, name, what = "条" }: { dir: "prev" | "next"; target: T | null; go: (to: T | null) => void; name?: string; what?: string }) {
  const label = `${dir === "prev" ? "上" : "下"}一${what}`;
  const shown = name ?? (typeof target === "string" ? target : "");
  return <button type="button" className="scv-side" aria-label={label} title={target !== null ? `${label}${shown ? `：${shown}` : ""}（${dir === "prev" ? "←" : "→"}）` : dir === "prev" ? `已经是第一${what}` : `已经是最后一${what}`} disabled={target === null} onClick={() => go(target)}>{dir === "prev" ? <ChevronLeft size={26} /> : <ChevronRight size={26} />}</button>;
}

/**
 * 参考图放大看：同一个放大层，左右 / ← → 只在这一镜的参考图之间按 P1 → P2 → … 切换（和视频的上一条 / 下一条分开）。
 * 原图按原比例完整显示，不裁切；只看，不改任何东西。图片地址用受管 Object URL，换图或关闭就释放。
 */
export function RefImageViewer({ pictures, start, shotLabel, onClose }: { pictures: ViewerRef[]; start: string; shotLabel: string; onClose: () => void }) {
  const sequence = refSequence(pictures);
  const [tag, setTag] = useState(start);
  const nav = refNav(sequence, tag);
  const picture = sequence[nav.index] ?? null;
  const source = picture?.src ?? "";
  const [url, setUrl] = useState("");
  const [failed, setFailed] = useState("");
  useEffect(() => {
    if (!source) return;
    let active = true;
    let held: { key: string | null; url: string; revoke: boolean } | null = null;
    setUrl(""); setFailed("");
    void acquireMediaUrl(source).then((media) => {
      if (!active) { releaseMediaUrl(media.key); if (media.revoke) URL.revokeObjectURL(media.url); return; }
      held = media;
      setUrl(media.url);
    }).catch(() => { if (active) setFailed("读不到这张图（可能已被删掉或移走）"); });
    return () => { active = false; if (held) { releaseMediaUrl(held.key); if (held.revoke) URL.revokeObjectURL(held.url); } };
  }, [source]);
  const go = (to: string | null) => { if (to) setTag(to); };
  useViewerKeys(nav.prev, nav.next, go, onClose);
  if (!picture) return <div className="scv-shade" role="dialog" aria-modal="true" aria-label="放大看参考图" onClick={onClose}><p className="scv-empty">这张参考图不在了</p></div>;
  const name = (tagOf: string | null) => { const item = sequence.find((entry) => entry.tag === tagOf); return item ? `${item.tag} ${item.name}` : undefined; };
  return <div className="scv-shade" role="dialog" aria-modal="true" aria-label={`放大看参考图：${picture.tag} ${picture.name}`} onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <SideButton dir="prev" target={nav.prev} go={go} name={name(nav.prev)} what="张" />
    <div className="scv-stage">
      <header className="scv-head">
        <div className="scv-title"><b>{picture.tag}</b><span title={picture.name}>{picture.group} · {picture.name}</span><small>{nav.index + 1} / {sequence.length}</small></div>
        {refIds(picture).length > 0 && <div className="scv-ids">{refIds(picture).map((item) => <span key={item.kind} className="scv-id"><em>{item.kind}</em><code title={item.id}>{clipMiddle(item.id)}</code><button type="button" aria-label={`复制${item.kind}`} title={`复制${item.kind}（纯文本）`} onClick={() => void copyPlainText(item.id, `已复制${item.kind}`)}>复制</button></span>)}</div>}
        <div className="scv-state" title="这张参考图属于哪一镜（只看不改）">{shotLabel}</div>
        <button type="button" className="scv-close" aria-label="关闭放大（Esc）" title="关闭（Esc）" onClick={onClose}><X size={18} /></button>
      </header>
      <div className="scv-frame">
        {url ? <img className="scv-img" src={url} alt={`${picture.tag} ${picture.name}`} draggable={false} /> : <div className="scv-wait scv-wait-img"><span>{failed || "正在读取图片…"}</span></div>}
      </div>
    </div>
    <SideButton dir="next" target={nav.next} go={go} name={name(nav.next)} what="张" />
  </div>;
}

export const VIEWER_STYLE = `
.scv-shade{position:absolute;inset:0;z-index:30;display:flex;align-items:center;justify-content:center;gap:18px;padding:3vh 16px;background:rgba(12,12,12,.74);backdrop-filter:blur(2px)}
.scv-stage{display:flex;flex-direction:column;align-items:stretch;gap:8px;height:94vh;max-height:100%;min-width:0}
.scv-head{display:flex;align-items:center;gap:12px;min-width:0;color:var(--ff-text-2)}
.scv-title{display:flex;align-items:baseline;gap:8px;min-width:0;flex:1}
.scv-title b{font:600 15px/1.3 var(--ff-mono);color:var(--ff-text)}
.scv-title span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--ff-text);font-size:14px}
.scv-title small{color:var(--ff-text-3);font-size:12px;white-space:nowrap}
.scv-state{font-size:12px;color:var(--ff-text-3);white-space:nowrap}
.scv-ids{display:flex;align-items:center;gap:10px;min-width:0;flex:0 1 auto}
.scv-id{display:inline-flex;align-items:baseline;gap:5px;min-width:0;font-size:11.5px;color:var(--ff-text-3)}
.scv-id em{font-style:normal;white-space:nowrap}
.scv-id code{font:11.5px var(--ff-mono);color:var(--ff-text-2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;user-select:all}
.scv-id button{padding:1px 7px;border:1px solid var(--ff-border);border-radius:var(--ff-r-sm);background:transparent;color:var(--ff-text-3);font-size:11px;cursor:pointer}
.scv-id button:hover{border-color:var(--ff-border-strong);color:var(--ff-text)}
.sc-thumb figcaption .sc-thumb-id{float:right;display:inline-grid;place-items:center;width:14px;height:14px;padding:0;margin-left:2px;border:0;background:none;color:var(--ff-text-3);cursor:pointer;opacity:0}
.sc-thumb:hover figcaption .sc-thumb-id,.sc-thumb-id:focus-visible{opacity:1}
.sc-thumb-id svg{width:11px;height:11px}.sc-thumb-id:hover{color:var(--ff-text)}
.scv-close{display:grid;place-items:center;width:30px;height:30px;border-radius:var(--ff-r-sm);border:1px solid var(--ff-border);background:var(--ff-control);color:var(--ff-text-2)}
.scv-close:hover{background:var(--ff-hover);color:var(--ff-text)}
.scv-frame{position:relative;flex:1;min-height:0;display:flex;justify-content:center}
.scv-frame video,.scv-wait{height:100%;width:auto;max-width:min(64vw,100%);border-radius:var(--ff-r);border:1px solid var(--ff-border);background:#000;object-fit:contain}
.scv-aside{flex:none;width:min(300px,28vw);margin-left:12px;overflow:auto;align-self:stretch}.scv-aside .sc-t2v{font-size:13px;color:var(--ff-text-2);border-color:var(--ff-border-strong)}
.scv-frame.stale video{outline:2px dashed var(--ff-line-strong);outline-offset:-2px}
.scv-wait{display:grid;place-items:center;background:var(--ff-sunken) center/cover no-repeat}
.scv-wait span{padding:4px 10px;border-radius:var(--ff-r-sm);background:rgba(12,12,12,.8);color:var(--ff-text-2);font-size:12px}
.scv-play{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);display:grid;place-items:center;width:56px;height:56px;border-radius:50%;border:1px solid var(--ff-border-strong);background:rgba(12,12,12,.78);color:var(--ff-text)}
.scv-play:hover{background:var(--ff-hover)}
.scv-foot{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap}
.scv-tags{display:flex;flex-wrap:wrap;gap:6px}
.scv-tags button,.scv-locate{display:inline-flex;align-items:center;gap:5px;padding:3px 10px;border-radius:var(--ff-r-sm);border:1px solid var(--ff-border);background:var(--ff-control);color:var(--ff-text-2);font-size:12px}
.scv-tags button:hover,.scv-locate:hover{background:var(--ff-hover);color:var(--ff-text)}
.scv-tags button.on{border-color:var(--ff-border-hover);background:var(--ff-hover);color:var(--ff-text)}
.scv-tags button.stale{border-style:dashed}
.scv-side{flex:none;display:grid;place-items:center;width:46px;height:88px;border-radius:var(--ff-r);border:1px solid var(--ff-border);background:var(--ff-raised);color:var(--ff-text-2)}
.scv-side:hover:not(:disabled){background:var(--ff-hover);color:var(--ff-text)}
.scv-side:disabled{opacity:.32;cursor:default}
.scv-img{max-width:min(78vw,100%);max-height:100%;width:auto;height:auto;object-fit:contain;align-self:center;border-radius:var(--ff-r);border:1px solid var(--ff-border);background:var(--ff-sunken)}
.scv-wait-img{width:min(60vw,640px);height:auto;aspect-ratio:4/3;align-self:center}
.scv-foot .scd.compact .scd-sound{display:none}
.sc-thumb-zoom{display:block;width:100%;padding:0;border:0;background:none;text-align:inherit;cursor:zoom-in}
.scv-empty{padding:10px 16px;border-radius:var(--ff-r);background:var(--ff-raised);color:var(--ff-text-2)}
.sc-video .sc-zoom svg,.sc-video .sc-zoom:hover svg{padding:0;width:14px;height:14px;border:0;border-radius:0;background:none;color:inherit}
.sc-video .sc-zoom{position:absolute;inset:6px 6px auto auto;z-index:2;display:grid;place-items:center;width:26px;height:26px;padding:0;border-radius:var(--ff-r-sm);border:1px solid var(--ff-border);background:rgba(12,12,12,.8);color:var(--ff-text-2)}
.sc-video .sc-zoom:hover{background:var(--ff-hover);color:var(--ff-text)}
`;
