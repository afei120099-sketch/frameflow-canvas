"use client";

import { ChangeEvent, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ArrowLeft, FolderOpen, GitBranch, Image as ImageIcon, Mic2, Pause, Play, Plus, Video, X } from "lucide-react";
import { openLineage } from "@/components/lineage-viewer";
import { useImageThumbnail } from "@/components/canvas/use-image-thumbnail";
import { acquireMediaUrl, releaseMediaUrl } from "@/lib/local-video-store";
import { getAsset, listAssets, listRuns, listShots, renameAsset, type AssetRecord, type RunRecord, type ShotRecord } from "@/lib/production-records";
import { announceAssetRenamed } from "@/lib/asset-name";
import { addRoleAsset, listRoles, type RoleRecord } from "@/lib/role-records";
import { assetShotStatus, assetSourceLabel, filterAssets, formatAssetMeta, isLibraryAsset, LIBRARY_PAGE_SIZE, OwnedObjectUrls, roleKindForAsset, rolesUsingAsset, type LibraryKind, type LibrarySort } from "@/lib/asset-library";
import { roleImageIds, selectAssetAiExport } from "@/lib/asset-ai-manifest";
import { exportAssetsForAi } from "@/lib/asset-ai-export";
import { currentLibraryScope } from "@/lib/canvas-library-scope";
import { copyPlainText } from "@/lib/copy-plain-text";
import { isTypingTarget } from "@/lib/keyboard-guards";

type ImportKind = "image" | "video" | "audio";
const KIND_TABS: { value: LibraryKind; label: string }[] = [{ value: "all", label: "全部" }, { value: "image", label: "图片" }, { value: "video", label: "视频" }, { value: "audio", label: "声音" }];
const KIND_NAMES = { image: "图片", video: "视频", audio: "声音" } as const;

/** Image thumbnail that only resolves its media once the card scrolls into view. */
function LazyImage({ asset }: { asset: AssetRecord }) {
  const holder = useRef<HTMLSpanElement>(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const element = holder.current;
    if (!element || typeof IntersectionObserver === "undefined") { queueMicrotask(() => setVisible(true)); return; }
    const observer = new IntersectionObserver((entries) => { if (entries.some((entry) => entry.isIntersecting)) { setVisible(true); observer.disconnect(); } }, { rootMargin: "200px" });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const src = useImageThumbnail(visible ? asset.storageReference : "", 256).url;
  return <span ref={holder} className="asset-library-thumb">{src ? <img src={src} alt="" decoding="async" loading="lazy" draggable={false} /> : <ImageIcon size={20} />}</span>;
}

// 素材库只列「当前画布上正放着的」导入素材（用户 2026-11-13 定）；本次刚从素材库导入、还没放上画布的也先列着。
const justImported = new Set<string>();
const onCurrentCanvas = (asset: AssetRecord) => { const refs = currentLibraryScope()?.references; return !refs || refs.has(asset.assetId) || refs.has(asset.storageReference) || justImported.has(asset.assetId); };
const visibleInLibrary = (asset: AssetRecord) => isLibraryAsset(asset) && onCurrentCanvas(asset);
const fetchLibrary = () => Promise.all([listAssets(), listRuns(), listShots(), listRoles()]);

function AssetNameField({ filename, disabled, onCommit }: { filename: string; disabled: boolean; onCommit: (name: string) => void }) {
  const [value, setValue] = useState(filename);
  useEffect(() => { setValue(filename); }, [filename]);
  return <label className="asset-rename"><span>名称</span><input aria-label="素材名称" value={value} disabled={disabled} placeholder="例如：雨夜进门" onPointerDown={(event) => event.stopPropagation()} onChange={(event) => setValue(event.target.value)} onBlur={() => { if (value !== filename) onCommit(value); }} onKeyDown={(event) => { event.stopPropagation(); if (event.key === "Enter") { event.preventDefault(); event.currentTarget.blur(); } if (event.key === "Escape") { event.preventDefault(); setValue(filename); } }} /></label>;
}

export function AssetLibrary({ onClose, onPlace, onImport }: { onClose: () => void; onPlace: (asset: AssetRecord) => Promise<void>; onImport: (kind: ImportKind, file: File) => Promise<AssetRecord> }) {
  const [assets, setAssets] = useState<AssetRecord[]>([]);
  const [runs, setRuns] = useState<Map<string, RunRecord>>(new Map());
  const [shots, setShots] = useState<Map<string, ShotRecord>>(new Map());
  const [roles, setRoles] = useState<RoleRecord[]>([]);
  const [kind, setKind] = useState<LibraryKind>("all");
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<LibrarySort>("newest");
  const [limit, setLimit] = useState(LIBRARY_PAGE_SIZE);
  const [selectedId, setSelectedId] = useState("");
  const [roleChoice, setRoleChoice] = useState("");
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [working, setWorking] = useState(false);
  const [exportProgress, setExportProgress] = useState("");
  const [playingId, setPlayingId] = useState("");
  const [previewUrl, setPreviewUrl] = useState("");
  const audioRef = useRef<HTMLAudioElement>(null);
  const owned = useRef(new OwnedObjectUrls());
  const playingRelease = useRef<{ key: string | null; revoke: boolean; url: string } | null>(null);
  const playGen = useRef(0);
  const imageInput = useRef<HTMLInputElement>(null);
  const videoInput = useRef<HTMLInputElement>(null);
  const audioInput = useRef<HTMLInputElement>(null);

  const apply = ([nextAssets, nextRuns, nextShots, nextRoles]: Awaited<ReturnType<typeof fetchLibrary>>) => {
    setAssets(nextAssets.filter(visibleInLibrary));
    setRuns(new Map(nextRuns.map((run) => [run.runId, run])));
    setShots(new Map(nextShots.map((shot) => [shot.shotId, shot])));
    setRoles(nextRoles);
  };
  const load = async () => apply(await fetchLibrary());
  useEffect(() => { let active = true; void fetchLibrary().then((data) => { if (active) apply(data); }).catch((cause) => { if (active) setError(cause instanceof Error ? cause.message : "素材读取失败"); }); return () => { active = false; }; }, []);
  useEffect(() => { const onKey = (event: KeyboardEvent) => { if (event.key === "Escape" && !event.isComposing && !isTypingTarget(event.target)) { event.stopPropagation(); onClose(); } }; window.addEventListener("keydown", onKey, true); return () => window.removeEventListener("keydown", onKey, true); }, [onClose]);
  // Every URL the library created itself is revoked when it closes.
  useEffect(() => { const urls = owned.current; return () => { urls.revokeAll(); playGen.current += 1; const held = playingRelease.current; playingRelease.current = null; if (held) { releaseMediaUrl(held.key); if (held.revoke && held.url) URL.revokeObjectURL(held.url); } }; }, []);
  const pickFile = (type: ImportKind) => (type === "image" ? imageInput : type === "video" ? videoInput : audioInput).current?.click();

  const filtered = useMemo(() => filterAssets(assets, { kind, search, sort }), [assets, kind, search, sort]);
  const visible = filtered.slice(0, limit);
  const selected = assets.find((asset) => asset.assetId === selectedId) ?? null;

  // One media URL for the detail preview (image / single video player / audio).
  useEffect(() => {
    if (!selected || selected.kind === "image") { queueMicrotask(() => setPreviewUrl("")); return; }
    let active = true; let key: string | null = null; let revoke = false; let ownedUrl = "";
    void acquireMediaUrl(selected.storageReference).then((result) => {
      if (!active) { releaseMediaUrl(result.key); if (result.revoke && result.url) URL.revokeObjectURL(result.url); return; }
      key = result.key; revoke = result.revoke; ownedUrl = result.revoke ? result.url : ""; setPreviewUrl(result.url);
    }).catch(() => { if (active) setPreviewUrl(""); });
    return () => { active = false; releaseMediaUrl(key); if (revoke && ownedUrl) URL.revokeObjectURL(ownedUrl); };
  }, [selected]);

  const act = async (action: () => Promise<string | void>) => {
    if (working) return;
    setWorking(true); setError(""); setNotice("");
    try { const message = await action(); if (message) setNotice(message); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "素材操作失败"); }
    finally { setWorking(false); }
  };
  const importFile = (type: ImportKind) => (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]; event.target.value = "";
    if (file) void act(async () => { const asset = await onImport(type, file); justImported.add(asset.assetId); await load(); setSelectedId(asset.assetId); return `已加入素材库：${asset.filename}（未创建画布节点）`; });
  };
  const toggleAudio = async (asset: AssetRecord) => {
    const player = audioRef.current;
    if (!player) return;
    if (playingId === asset.assetId) { playGen.current += 1; player.pause(); player.removeAttribute("src"); const held = playingRelease.current; playingRelease.current = null; if (held) { releaseMediaUrl(held.key); if (held.revoke && held.url) URL.revokeObjectURL(held.url); } setPlayingId(""); return; }
    if (!asset.storageReference.startsWith("audio:")) { setError("该声音以旧方式保存（media:），请在详情中试听"); return; }
    const gen = ++playGen.current;
    const previous = playingRelease.current; playingRelease.current = null; if (previous) { releaseMediaUrl(previous.key); if (previous.revoke && previous.url) URL.revokeObjectURL(previous.url); }
    const acquired = await acquireMediaUrl(asset.storageReference);
    if (playGen.current !== gen) { releaseMediaUrl(acquired.key); if (acquired.revoke && acquired.url) URL.revokeObjectURL(acquired.url); return; }
    playingRelease.current = { key: acquired.key, revoke: acquired.revoke, url: acquired.url };
    player.src = acquired.url;
    setPlayingId(asset.assetId);
    await player.play().catch(() => setPlayingId(""));
  };
  const addToRole = (asset: AssetRecord) => void act(async () => {
    const roleKind = roleKindForAsset(asset);
    if (!roleKind || !roleChoice) throw new Error("请先选择角色");
    const result = await addRoleAsset(roleChoice, asset.assetId, roleKind);
    await load();
    return result.added ? `已加入角色“${result.role.displayName}”的${roleKind === "image" ? "外观" : "声音"}` : `该素材已在角色“${result.role.displayName}”中，未重复加入`;
  });

  const copyForAi = () => void act(async () => {
    setExportProgress('正在准备');
    try {
      const [currentAssets, , , currentRoles] = await fetchLibrary();
      const present = new Set(currentAssets.filter(visibleInLibrary).map(asset => asset.assetId));
      const fetched = new Set(currentAssets.map(asset => asset.assetId));
      const missingIds = [...roleImageIds(currentRoles)].filter(id => !fetched.has(id));
      const linked = await Promise.all(missingIds.map(id => getAsset(id)));
      const exportAssets = selectAssetAiExport([...currentAssets, ...linked.filter((asset): asset is AssetRecord => !!asset)], currentRoles, present);
      const result = await exportAssetsForAi(exportAssets, currentRoles, (done, total) => setExportProgress(`正在导出 ${done}/${total}`), currentLibraryScope()?.pageName || "当前画布", fetched);
      if (!await copyPlainText(result.instructions)) throw new Error(`清单已保存到 ${result.folder}，但复制失败，请允许剪贴板访问后重试`);
      return `已复制，清单在 ${result.folder}`;
    } finally { setExportProgress(''); }
  });

  const copyAssetId = (assetId: string) => { void copyPlainText(assetId).then((ok) => { setError(""); setNotice(ok ? "已复制 Asset ID" : "复制失败，请手动选择 Asset ID"); }); };
  const rename = (asset: AssetRecord, name: string) => void act(async () => {
    const next = await renameAsset(asset.assetId, name);
    await load();
    announceAssetRenamed(next.assetId, next.filename);
    return next.filename === asset.filename ? undefined : `已重命名为 ${next.filename}`;
  });
  const shotStatus = selected ? assetShotStatus(selected, selected.shotId ? shots.get(selected.shotId) : null, runs) : null;
  const usedBy = selected ? rolesUsingAsset(selected.assetId, roles) : [];
  const field = (label: string, value: unknown) => <><dt>{label}</dt><dd>{value === undefined || value === null || value === "" ? "—" : String(value)}</dd></>;

  return createPortal(<aside className="asset-library-drawer" role="dialog" aria-label="素材库" onPointerDown={(event) => event.stopPropagation()} onWheel={(event) => event.stopPropagation()}>
    <header><div><small>画布上的素材 · {assets.length}</small><h2>素材库</h2></div><button type="button" className="asset-ai-copy" disabled={working} onClick={copyForAi}>{exportProgress || "复制给 AI"}</button><button type="button" title="关闭素材库" aria-label="关闭素材库" onClick={onClose}><X size={17} /></button></header>
    {selected ? <div className="asset-library-detail">
      <button type="button" className="role-back" onClick={() => { setSelectedId(""); setNotice(""); setError(""); }}><ArrowLeft size={15} />返回素材列表</button>
      <div className="asset-library-preview">{selected.kind === "image" ? <LazyImage asset={selected} /> : selected.kind === "video" ? (previewUrl ? <video src={previewUrl} controls playsInline preload="metadata" /> : <Video size={28} />) : (previewUrl ? <audio src={previewUrl} controls preload="metadata" /> : <Mic2 size={28} />)}</div>
      <AssetNameField filename={selected.filename} disabled={working} onCommit={(name) => rename(selected, name)} />
      {shotStatus && <p className={`asset-library-badge ${shotStatus.adopted ? "adopted" : ""}`}>{shotStatus.label}{selected.shotId && shots.get(selected.shotId) ? ` · ${shots.get(selected.shotId)!.title}` : ""}</p>}
      <dl>
        <dt>Asset ID</dt><dd><div className="id-copy-row"><code title={selected.assetId}>{selected.assetId}</code><button type="button" onClick={() => copyAssetId(selected.assetId)}>复制</button></div></dd>{field("文件名", selected.filename)}{field("类型", KIND_NAMES[selected.kind] ?? selected.kind)}{field("MIME", selected.mimeType)}
        {field("创建时间", selected.createdAt ? new Date(selected.createdAt).toLocaleString("zh-CN") : undefined)}
        {field("分辨率", selected.width && selected.height ? `${selected.width}×${selected.height}` : undefined)}
        {field("时长", typeof selected.duration === "number" ? `${selected.duration.toFixed(2)} 秒` : undefined)}
        {field("FPS", selected.fps)}{field("来源", assetSourceLabel(selected, runs))}{field("sourceRunId", selected.sourceRunId)}
        {field("sourceVideoAssetId", selected.sourceVideoAssetId)}{field("sourceAudioAssetId", selected.sourceAudioAssetId)}{field("derivationType", selected.derivationType)}
        {field("镜头", selected.shotId ? shots.get(selected.shotId)?.title ?? selected.shotId : undefined)}
        <dt>角色引用</dt><dd>{usedBy.length ? usedBy.map((role) => <div key={role.roleId}>{role.displayName} · {role.uses.join("、")}</div>) : "—"}</dd>
      </dl>
      <div className="asset-library-actions">
        <div className="asset-library-role"><button type="button" className="role-main-action" disabled={working} onClick={() => void act(async () => { await onPlace(selected); return "已放到画布（复用同一 Asset）"; })}><Plus size={15} />放到画布</button><button type="button" onClick={() => openLineage(selected.assetId)}><GitBranch size={13} />查看血缘</button></div>
        {roleKindForAsset(selected) && <div className="asset-library-role"><select value={roleChoice} onChange={(event) => setRoleChoice(event.target.value)}><option value="">选择角色</option>{roles.map((role) => <option key={role.roleId} value={role.roleId}>{role.displayName}</option>)}</select><button type="button" disabled={working || !roleChoice} onClick={() => addToRole(selected)}>{selected.kind === "image" ? "加入角色外观" : "加入角色声音"}</button></div>}
      </div>
    </div> : <>
      <div className="asset-library-toolbar">
        <div className="asset-library-imports">{(["image", "video", "audio"] as const).map((type) => <button type="button" key={type} disabled={working} onClick={() => pickFile(type)}><Plus size={13} />导入{KIND_NAMES[type]}</button>)}</div>
        <input ref={imageInput} type="file" accept="image/jpeg,image/png,image/webp" hidden onChange={importFile("image")} />
        <input ref={videoInput} type="file" accept="video/mp4" hidden onChange={importFile("video")} />
        <input ref={audioInput} type="file" accept="audio/*,.m4a" hidden onChange={importFile("audio")} />
        <div className="asset-library-tabs">{KIND_TABS.map((tab) => <button type="button" key={tab.value} className={kind === tab.value ? "active" : ""} onClick={() => { setKind(tab.value); setLimit(LIBRARY_PAGE_SIZE); }}>{tab.label}</button>)}</div>
        <div className="asset-library-filters"><input type="search" value={search} placeholder="搜索文件名" onChange={(event) => { setSearch(event.target.value); setLimit(LIBRARY_PAGE_SIZE); }} /><select value={sort} onChange={(event) => setSort(event.target.value as LibrarySort)}><option value="newest">最新优先</option><option value="oldest">最早优先</option><option value="name">文件名</option></select></div>
      </div>
      <div className="asset-library-list">
        {visible.length ? visible.map((asset) => <div role="button" tabIndex={0} key={asset.assetId} className="asset-library-card" title={asset.filename} onClick={() => { setSelectedId(asset.assetId); setNotice(""); setError(""); }} onKeyDown={(event) => { if (event.key === "Enter") setSelectedId(asset.assetId); }}>
          {asset.kind === "image" ? <LazyImage asset={asset} /> : <span className="asset-library-thumb">{asset.kind === "video" ? <Video size={20} /> : <Mic2 size={20} />}</span>}
          <span className="asset-library-card-text"><b>{asset.filename}</b><small>{[formatAssetMeta(asset), assetSourceLabel(asset, runs)].filter(Boolean).join(" · ")}</small><small title={asset.assetId}>{asset.assetId}</small></span>
          <span className="asset-library-card-actions"><button type="button" className="asset-id-copy" title="复制 Asset ID" aria-label={`复制 Asset ID ${asset.assetId}`} onClick={(event) => { event.stopPropagation(); copyAssetId(asset.assetId); }}>复制 ID</button>{asset.kind === "audio" && <button type="button" className="asset-library-play" title={playingId === asset.assetId ? "暂停" : "试听"} aria-label={playingId === asset.assetId ? "暂停" : "试听"} onClick={(event) => { event.stopPropagation(); void toggleAudio(asset); }}>{playingId === asset.assetId ? <Pause size={13} /> : <Play size={13} />}</button>}</span>
        </div>) : <div className="role-empty"><FolderOpen size={20} />{assets.length ? "没有匹配的素材" : "素材库为空，可从上方导入"}</div>}
        {filtered.length > visible.length && <button type="button" className="asset-library-more" onClick={() => setLimit((value) => value + LIBRARY_PAGE_SIZE)}>显示更多（{filtered.length - visible.length}）</button>}
      </div>
    </>}
    <audio ref={audioRef} hidden onEnded={() => setPlayingId("")} />
    {(error || notice) && <p className={error ? "role-error" : "role-notice"} role="status">{error || notice}</p>}
  </aside>, document.body);
}
