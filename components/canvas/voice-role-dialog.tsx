"use client";
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { listRoles, type RoleRecord } from '@/lib/role-records';
import { attachVoiceToRole } from '@/lib/voice-role-attach';

export function VoiceRoleDialog({assetId,onClose,onSaved,defaultPrimary=false}:{assetId:string;onClose:()=>void;onSaved:(roleId:string)=>void;defaultPrimary?:boolean}) {
  const [roles,setRoles]=useState<RoleRecord[]>([]),[roleId,setRoleId]=useState(''),[name,setName]=useState('');
  const [primary,setPrimary]=useState(defaultPrimary),[busy,setBusy]=useState(false),[error,setError]=useState('');
  useEffect(()=>{let live=true;void listRoles().then(data=>{if(live)setRoles(data);}).catch(cause=>{if(live)setError(String(cause));});return()=>{live=false;};},[]);
  const save=async()=>{
    if(busy)return;setBusy(true);setError('');
    try {
      const role=await attachVoiceToRole(assetId,{roleId:roleId||undefined,newName:name,primary});
      onSaved(role.roleId);
    }catch(cause){setError(cause instanceof Error?cause.message:'加入角色失败');}finally{setBusy(false);}
  };
  return createPortal(<div className="generation-info-backdrop" onPointerDown={e=>{e.stopPropagation();if(e.target===e.currentTarget&&!busy)onClose();}}>
    <section className="generation-info-panel" style={{maxWidth:480}} role="dialog" aria-modal="true" aria-label="将配音加入角色" onPointerDown={e=>e.stopPropagation()} onKeyDown={e=>{e.stopPropagation();if(e.key==='Escape'&&!busy)onClose();}}>
      <header><h2>将配音加入角色</h2><button type="button" disabled={busy} aria-label="关闭" onClick={onClose}>×</button></header>
      <div style={{display:'grid',gap:14,padding:20}}>
        <label>选择角色<select aria-label="配音加入的角色" disabled={busy} value={roleId} onChange={e=>setRoleId(e.target.value)}><option value="">新建角色</option>{roles.map(role=><option key={role.roleId} value={role.roleId}>{role.displayName}</option>)}</select></label>
        {!roleId&&<label>角色名称<input aria-label="新角色名称" disabled={busy} value={name} onChange={e=>setName(e.target.value)} placeholder="输入角色名称" /></label>}
        <label><input type="checkbox" disabled={busy} checked={primary} onChange={e=>setPrimary(e.target.checked)} />设为该角色的主声音</label>
        <small className="ff-hint">加入声音参考库后打开角色信息。首次添加声音会自动成为主声音；已有主声音时可勾选替换，原声音仍保留。</small>
        {error&&<p className="role-error" role="alert">{error}</p>}
        <button type="button" className="role-main-action" disabled={busy||(!roleId&&!name.trim())} onClick={()=>void save()}>{busy?'保存中…':'加入并打开角色信息'}</button>
      </div>
    </section>
  </div>,document.body);
}
