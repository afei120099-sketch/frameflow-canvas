"use client";
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { listRoles, type RoleRecord } from '@/lib/role-records';
import { attachImageToRole } from '@/lib/image-role-attach';

export function ImageRoleDialog({ assetId, onClose, onSaved }: { assetId: string; onClose: () => void; onSaved: (roleId: string) => void }) {
  const [roles, setRoles] = useState<RoleRecord[]>([]), [roleId, setRoleId] = useState(''), [name, setName] = useState('');
  const [primary, setPrimary] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('');
  useEffect(() => { let live = true; void listRoles().then(data => { if (live) setRoles(data); }).catch(cause => { if (live) setError(String(cause)); }); return () => { live = false; }; }, []);
  const save = async () => {
    if (busy) return; setBusy(true); setError('');
    try {
      const role = await attachImageToRole(assetId, { roleId: roleId || undefined, newName: name, primary });
      onSaved(role.roleId);
    } catch (cause) { setError(cause instanceof Error ? cause.message : '加入角色失败'); } finally { setBusy(false); }
  };
  return createPortal(<div className="generation-info-backdrop" onPointerDown={e => { e.stopPropagation(); if (e.target === e.currentTarget && !busy) onClose(); }}>
    <section className="generation-info-panel" style={{ maxWidth: 480 }} role="dialog" aria-modal="true" aria-label="将图片加入角色" onPointerDown={e => e.stopPropagation()} onKeyDown={e => { e.stopPropagation(); if (e.key === 'Escape' && !busy) onClose(); }}>
      <header><h2>将图片加入角色</h2><button type="button" disabled={busy} aria-label="关闭" onClick={onClose}>×</button></header>
      <div style={{ display: 'grid', gap: 14, padding: 20 }}>
        <label>选择角色<select aria-label="图片加入的角色" disabled={busy} value={roleId} onChange={e => setRoleId(e.target.value)}><option value="">新建角色</option>{roles.map(role => <option key={role.roleId} value={role.roleId}>{role.displayName}</option>)}</select></label>
        {!roleId && <label>角色名称<input aria-label="新角色名称" disabled={busy} value={name} onChange={e => setName(e.target.value)} placeholder="输入角色名称" /></label>}
        <label><input type="checkbox" disabled={busy} checked={primary} onChange={e => setPrimary(e.target.checked)} />设为该角色的主外观参考</label>
        <small className="ff-hint">这张图片会加入所选角色的外观参考，可在角色库里查看。角色还没有主外观参考时，首次添加会自动成为主参考；已有主参考时勾选上方选项才会替换，原图片仍保留。</small>
        {error && <p className="role-error" role="alert">{error}</p>}
        <button type="button" className="role-main-action" disabled={busy || (!roleId && !name.trim())} onClick={() => void save()}>{busy ? '保存中…' : '添加进角色'}</button>
      </div>
    </section>
  </div>, document.body);
}
