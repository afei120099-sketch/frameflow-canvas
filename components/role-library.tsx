"use client";

import { ChangeEvent, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ArrowLeft, Copy, Image as ImageIcon, Mic2, Plus, Star, Trash2, Users, X } from "lucide-react";
import { useImageThumbnail } from "@/components/canvas/use-image-thumbnail";
import { listAssets, type AssetRecord } from "@/lib/production-records";
import { copyPlainText } from "@/lib/copy-plain-text";
import { isTypingTarget } from "@/lib/keyboard-guards";
import { addRoleAsset, createRole, deleteRole, listRoles, removeRoleAsset, setPrimaryRoleAsset, updateRoleDetails, type RoleRecord, type RoleAssetKind } from "@/lib/role-records";
import { askConfirm } from "@/components/in-page-dialog";

function AssetImage({ asset, className = "" }: { asset: AssetRecord; className?: string }) {
  const src = useImageThumbnail(asset.storageReference, 256).url;
  return src ? <img className={className} src={src} alt={asset.filename} decoding="async" loading="lazy" draggable={false} /> : <ImageIcon size={23} />;
}

export function AssetPicker({ kind, title, onChoose, onUpload, onClose, multiple = false, onChooseMany }: { kind: "image" | "video" | "audio"; title: string; onChoose: (asset: AssetRecord) => Promise<void>; onUpload: (file: File) => Promise<void>; onClose: () => void; multiple?: boolean; onChooseMany?: (assets: AssetRecord[]) => Promise<void> }) {
  const [assets, setAssets] = useState<AssetRecord[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { let active = true; void listAssets(kind).then((items) => { if (active) setAssets(items.filter((item) => !item.storageReference.startsWith("legacy-inline:"))); }).catch((cause) => { if (active) setError(cause instanceof Error ? cause.message : "素材读取失败"); }); return () => { active = false; }; }, [kind]);
  useEffect(() => { const onKey = (event: KeyboardEvent) => { if (event.key === "Escape" && !event.isComposing && !isTypingTarget(event.target)) { event.stopPropagation(); onClose(); } }; window.addEventListener("keydown", onKey, true); return () => window.removeEventListener("keydown", onKey, true); }, [onClose]);
  const run = async (action: () => Promise<void>) => { if (busy) return; setBusy(true); setError(""); try { await action(); onClose(); } catch (cause) { setError(cause instanceof Error ? cause.message : "素材操作失败"); } finally { setBusy(false); } };
  const unit = kind === "image" ? "张" : "个";
  const toggle = (assetId: string) => setSelectedIds((current) => current.includes(assetId) ? current.filter((id) => id !== assetId) : [...current, assetId]);
  const confirmMany = () => { const chosen = assets.filter((asset) => selectedIds.includes(asset.assetId)); if (chosen.length) void run(async () => { if (onChooseMany) await onChooseMany(chosen); else for (const asset of chosen) await onChoose(asset); }); };
  const upload = (event: ChangeEvent<HTMLInputElement>) => { const files = [...(event.target.files ?? [])]; event.target.value = ""; if (!files.length) return; const chosen = multiple ? files : files.slice(0, 1); void run(async () => { for (const file of chosen) await onUpload(file); }); };
  return createPortal(<div className="generation-info-backdrop" onPointerDown={(event) => { event.stopPropagation(); if (event.target === event.currentTarget) onClose(); }}>
    <div className="generation-info-panel asset-picker-panel" role="dialog" aria-modal="true" aria-label={title} onPointerDown={(event) => event.stopPropagation()}>
      <header><div><small>当前画布素材</small><h2>{title}</h2></div><button type="button" title="关闭" onClick={onClose}><X size={17} /></button></header>
      <div className="asset-picker-body"><button type="button" className="role-main-action" disabled={busy} onClick={() => input.current?.click()}><Plus size={15} />上传新{kind === "image" ? "图片" : kind === "audio" ? "声音" : "视频"}{multiple ? "（可多选）" : ""}</button>
        <input ref={input} type="file" multiple={multiple} accept={kind === "image" ? "image/jpeg,image/png,image/webp" : kind === "audio" ? "audio/*,.m4a" : "video/mp4"} hidden onChange={upload} />
        <p>或选择已导入的{kind === "image" ? "图片" : kind === "audio" ? "声音" : "视频"} Asset{multiple ? "，点击图片逐张勾选，选完点下方【添加所选】" : ""}</p>
        {assets.length ? <div className="asset-picker-grid">{assets.map((asset) => { const chosen = selectedIds.includes(asset.assetId); return <button type="button" key={asset.assetId} className={chosen ? "selected" : undefined} aria-pressed={multiple ? chosen : undefined} title={asset.filename} disabled={busy} onClick={() => multiple ? toggle(asset.assetId) : void run(() => onChoose(asset))}><span className="asset-picker-thumb">{kind === "image" ? <AssetImage asset={asset} /> : kind === "audio" ? <Mic2 size={23} /> : <ImageIcon size={23} />}</span>{chosen && <span className="asset-picker-check">已选</span>}<span>{asset.filename}</span></button>; })}</div> : <div className="role-empty">当前还没有可选素材，可从上方上传。</div>}
        {multiple && <div className="asset-picker-actions"><span>已选 {selectedIds.length} {unit}</span><div><button type="button" disabled={busy || !selectedIds.length} onClick={() => setSelectedIds([])}>清空</button><button type="button" className="role-main-action" disabled={busy || !selectedIds.length} onClick={confirmMany}>添加所选（{selectedIds.length}）</button></div></div>}
        {error && <p className="role-error" role="alert">{error}</p>}
      </div>
    </div>
  </div>, document.body);
}

export function RoleLibrary({ onClose, onUpload, initialRoleId = "" }: { initialRoleId?: string; onClose: () => void; onUpload: (kind: RoleAssetKind, file: File) => Promise<AssetRecord> }) {
  const [roles, setRoles] = useState<RoleRecord[]>([]);
  const [assets, setAssets] = useState<AssetRecord[]>([]);
  const [selectedId, setSelectedId] = useState(initialRoleId);
  const [nameDraft, setNameDraft] = useState("");
  const [descriptionDraft, setDescriptionDraft] = useState("");
  const [newName, setNewName] = useState("");
  const [pickerKind, setPickerKind] = useState<RoleAssetKind | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [working, setWorking] = useState(false);
  const selected = roles.find((role) => role.roleId === selectedId);
  const assetById = new Map(assets.map((asset) => [asset.assetId, asset]));
  const refresh = async () => { const [nextRoles, nextAssets] = await Promise.all([listRoles(), listAssets()]); setRoles(nextRoles); setAssets(nextAssets); };
  useEffect(() => { void Promise.all([listRoles(), listAssets()]).then(([nextRoles, nextAssets]) => { setRoles(nextRoles); setAssets(nextAssets); const initial=nextRoles.find(role=>role.roleId===initialRoleId); if(initial){setNameDraft(initial.displayName);setDescriptionDraft(initial.description);} }).catch((cause) => setError(cause instanceof Error ? cause.message : "角色资产读取失败")); }, [initialRoleId]);
  useEffect(() => { const onKey = (event: KeyboardEvent) => { if (event.key === "Escape" && !pickerKind && !event.isComposing && !isTypingTarget(event.target)) onClose(); }; window.addEventListener("keydown", onKey, true); return () => window.removeEventListener("keydown", onKey, true); }, [onClose, pickerKind]);
  const run = async (action: () => Promise<void>) => { if (working) return; setWorking(true); setError(""); setNotice(""); try { await action(); await refresh(); } catch (cause) { setError(cause instanceof Error ? cause.message : "角色保存失败"); } finally { setWorking(false); } };
  const addToRole = async (asset: AssetRecord, kind: RoleAssetKind) => { if (!selected) return; const result = await addRoleAsset(selected.roleId, asset.assetId, kind); await refresh(); setNotice(result.added ? "素材已加入角色" : "该素材已在角色中"); };
  const addManyToRole = async (chosen: AssetRecord[], kind: RoleAssetKind) => { if (!selected) return; let added = 0; for (const asset of chosen) { const result = await addRoleAsset(selected.roleId, asset.assetId, kind); if (result.added) added++; } await refresh(); const skipped = chosen.length - added; setNotice(added ? `已加入 ${added} ${kind === "image" ? "张外观参考" : "个声音参考"}${skipped ? `，${skipped} 个已在角色中` : ""}` : "所选素材已在角色中"); };
  const selectRole = (role: RoleRecord) => { setSelectedId(role.roleId); setNameDraft(role.displayName); setDescriptionDraft(role.description); setNotice(""); setError(""); };
  const copyRole = async (role: RoleRecord) => {
    const ok = await copyPlainText(`角色名称：${role.displayName}\nroleId: ${role.roleId}`);
    setError(ok ? "" : "复制失败，请进入角色详情手动复制名称和完整 roleId");
    setNotice(ok ? `已复制“${role.displayName}”的名称和完整 ID` : "");
  };
  const copyAllRoleIds = async () => {
    if (!roles.length) return;
    const lines = ["角色名称\troleId\t主外观\t主声音", ...roles.map((role) => [role.displayName, role.roleId, role.primaryAppearanceAssetId ?? "", role.primaryVoiceAssetId ?? ""].join("\t"))];
    const ok = await copyPlainText(lines.join("\n"));
    setError(ok ? "" : "复制失败，请进入角色详情手动复制名称和完整 roleId");
    setNotice(ok ? `已复制 ${roles.length} 个角色的名称和 ID` : "");
  };
  const create = () => void run(async () => { const role = await createRole(newName); selectRole(role); setNewName(""); });
  const saveDetails = () => { if (!selected || (nameDraft === selected.displayName && descriptionDraft === selected.description)) return; void run(async () => { await updateRoleDetails(selected.roleId, { displayName: nameDraft, description: descriptionDraft }); }); };
  const remove = (assetId: string, kind: RoleAssetKind) => { if (selected) void run(async () => { await removeRoleAsset(selected.roleId, assetId, kind); }); };
  const primary = (assetId: string, kind: RoleAssetKind) => { if (selected) void run(async () => { await setPrimaryRoleAsset(selected.roleId, assetId, kind); }); };
  const erase = async () => { if (!selected || !await askConfirm({ message: `删除角色“${selected.displayName}”？只删除角色卡，素材和历史生成结果会保留。`, confirmLabel: "删除", danger: true })) return; void run(async () => { await deleteRole(selected.roleId); setSelectedId(""); }); };
  const assetRow = (assetId: string, kind: RoleAssetKind, isPrimary: boolean) => { const asset = assetById.get(assetId); const source = asset?.sourceVideoAssetId ? assetById.get(asset.sourceVideoAssetId) : null; return <div className="role-asset-row" key={assetId}><span className="role-asset-thumb">{asset && kind === "image" ? <AssetImage asset={asset} /> : <Mic2 size={17} />}</span><span className="role-asset-name" title={asset?.filename ?? "素材记录不可用"}>{asset?.filename ?? "素材记录不可用"}{kind === "audio" && asset?.duration !== undefined && <small> · {asset.duration.toFixed(2)} 秒</small>}{source && <small title={source.filename}> · 来自视频：{source.filename}</small>}</span>{isPrimary && <small>{kind === "image" ? "主参考" : "主声音"}</small>}<button type="button" disabled={working || !asset} title={kind === "image" ? "设为主参考" : "设为主声音"} onClick={() => primary(assetId, kind)}><Star size={15} fill={isPrimary ? "currentColor" : "none"} /></button><button type="button" disabled={working} title="从角色移除（不删除素材）" onClick={() => remove(assetId, kind)}><X size={15} /></button></div>; };
  return <>{createPortal(<div className="generation-info-backdrop" onPointerDown={(event) => { event.stopPropagation(); if (event.target === event.currentTarget) onClose(); }}>
    <div className="generation-info-panel role-library-panel" role="dialog" aria-modal="true" aria-label="角色资产" onPointerDown={(event) => event.stopPropagation()}>
      <header><div><small>当前画布专属角色 · 切换画布后独立管理</small><h2>{selected ? selected.displayName : "角色资产"}</h2></div>{!selected && <button type="button" className="role-copy-all-btn" disabled={!roles.length} title="复制所有角色：每行「名称、roleId、主外观 assetId、主声音 assetId」，用制表符分隔，含表头" onClick={() => void copyAllRoleIds()}><Copy size={14} />复制全部角色 ID</button>}<button type="button" title="关闭" onClick={onClose}><X size={17} /></button></header>
      {selected ? <div className="role-detail"><button className="role-back" type="button" onClick={() => setSelectedId("")}><ArrowLeft size={15} />返回角色列表</button>
        <div className="id-copy-row"><span>roleId</span><code title={selected.roleId}>{selected.roleId}</code><button type="button" onClick={() => { void copyPlainText(selected.roleId).then((ok) => { setError(""); setNotice(ok ? "已复制 roleId" : "复制失败，请手动选择 roleId"); }); }}>复制</button></div>
        <label>角色名称<input value={nameDraft} onChange={(event) => setNameDraft(event.target.value)} onBlur={saveDetails} onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }} /></label>
        <div className="role-section-title"><b>外观参考 · {selected.appearanceAssetIds.length}</b><button type="button" onClick={() => setPickerKind("image")}><Plus size={14} />添加外观</button></div>
        {selected.appearanceAssetIds.length ? selected.appearanceAssetIds.map((id) => assetRow(id, "image", id === selected.primaryAppearanceAssetId)) : <p className="role-hint">尚未添加外观图片</p>}
        <div className="role-section-title"><b>声音参考 · {selected.voiceAssetIds.length}</b><button type="button" onClick={() => setPickerKind("audio")}><Plus size={14} />添加声音</button></div>
        {selected.voiceAssetIds.length ? selected.voiceAssetIds.map((id) => assetRow(id, "audio", id === selected.primaryVoiceAssetId)) : <p className="role-hint">尚未添加声音</p>}
        <label>角色描述<textarea value={descriptionDraft} placeholder="稳定外观、衣着与性格描述；镜头动作请写在镜头中。" onChange={(event) => setDescriptionDraft(event.target.value)} onBlur={saveDetails} /></label>
        <button type="button" className="role-delete" onClick={erase}><Trash2 size={14} />删除角色（保留素材）</button>
      </div> : <div className="role-list"><div className="role-create"><input value={newName} placeholder="角色名称，例如：柴犬" onChange={(event) => setNewName(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") create(); }} /><button type="button" className="role-main-action" disabled={working || !newName.trim()} onClick={create}><Plus size={15} />新建角色</button></div>
        {roles.length ? <div className="role-card-grid">{roles.map((role) => <div className="role-card" key={role.roleId}><button type="button" className="role-card-open" onClick={() => selectRole(role)}><span className="role-card-thumb">{role.primaryAppearanceAssetId && assetById.get(role.primaryAppearanceAssetId) ? <AssetImage asset={assetById.get(role.primaryAppearanceAssetId)!} /> : <Users size={29} />}</span><b>{role.displayName}</b><small>外观参考 {role.appearanceAssetIds.length} · 声音 {role.voiceAssetIds.length}</small><small title={role.roleId}>roleId {role.roleId}</small></button><button type="button" className="role-card-copy" title="复制角色名称和完整 ID" aria-label={`复制${role.displayName}的名称和ID`} onClick={() => void copyRole(role)}><Copy size={15} /></button></div>)}</div> : <div className="role-empty">还没有角色。输入名称即可创建，以后再补图片、声音和描述。</div>}
      </div>}
      {(error || notice) && <p className={error ? "role-error" : "role-notice"} role="status">{error || notice}</p>}
    </div>
  </div>, document.body)}
    {pickerKind && selected && <AssetPicker kind={pickerKind} title={pickerKind === "image" ? "添加外观参考" : "添加声音参考"} multiple={pickerKind === "image"} onChooseMany={(chosen) => addManyToRole(chosen, pickerKind)} onChoose={(asset) => addToRole(asset, pickerKind)} onUpload={async (file) => { const asset = await onUpload(pickerKind, file); await addToRole(asset, pickerKind); }} onClose={() => setPickerKind(null)} />}
  </>;
}
