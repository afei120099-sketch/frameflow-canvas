"use client";
import { useState } from 'react';
import { copyPlainText } from '@/lib/copy-plain-text';

export function CopyPromptButton({text,label='复制整个提示词'}:{text:string;label?:string}) {
  const [message,setMessage]=useState('');
  return <span className="copy-prompt-control"><button type="button" disabled={!text} onPointerDown={event=>event.stopPropagation()} onClick={async event=>{
    event.stopPropagation();
    try { setMessage(await copyPlainText(text)?'已复制':'复制失败，请手动全选复制'); } catch { setMessage('复制失败，请手动全选复制'); }
  }}>{label}</button><button type="button" onPointerDown={event=>event.stopPropagation()} onClick={()=>window.dispatchEvent(new CustomEvent("frameflow-canvas-toolkit",{detail:{action:"prompts"}}))}>提示词库</button>{message && <small role="status">{message}</small>}</span>;
}
