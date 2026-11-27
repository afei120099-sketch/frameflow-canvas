import { shotListCsv } from './shot-prompt-checks.ts';

export function downloadShotList(name:string,shots:Parameters<typeof shotListCsv>[0]) {
  const url=URL.createObjectURL(new Blob([shotListCsv(shots)],{type:'text/csv;charset=utf-8'}));
  const link=document.createElement('a');
  link.href=url;link.download=name.replace(/[<>:"/\\|?*\u0000-\u001f]/g,'_')+'.csv';
  document.body.appendChild(link);link.click();link.remove();
  setTimeout(()=>URL.revokeObjectURL(url),1000);
}

/** 镜头卡片「导出 JSON」: the queue text exactly as it is in the 队列 box (what 入队 would submit). */
export function downloadQueueJson(title:string,text:string) {
  const url=URL.createObjectURL(new Blob([text],{type:'application/json;charset=utf-8'}));
  const link=document.createElement('a');
  link.href=url;link.download=(title||'镜头队列').replace(/[<>:"/\\|?*\u0000-\u001f]/g,'_')+'.json';
  document.body.appendChild(link);link.click();link.remove();
  setTimeout(()=>URL.revokeObjectURL(url),1000);
}
