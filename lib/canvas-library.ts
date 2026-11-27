import { confirmCanvasRecords } from './canvas-save-status.ts';
import { withCanvasBackgroundWork } from './canvas-background-work.ts';
export function requireCanvasSwitchIdle(generating:boolean,batchActive:boolean){
  if(generating||batchActive)throw Error('正在渲染或批量排队，请完成或停止任务后再新建、切换画布');
}
export function canvasName(value:string,existing:string[]=[],current?:string){
  const name=value.trim();
  if(!name||name.length>60)throw Error('画布名称请填写1–60个字');
  if(existing.some(other=>other!==current&&other.toLocaleLowerCase()===name.toLocaleLowerCase()))throw Error('这个画布名称已存在，请换一个');
  return name;
}
export async function waitForCanvasSave(key:string,records:ReadonlyMap<string,unknown>,options:{verify?:typeof confirmCanvasRecords;wait?:(ms:number)=>Promise<void>;attempts?:number;readRecords?:()=>ReadonlyMap<string,unknown>}={}){
  return withCanvasBackgroundWork(async()=>{
  for(let attempt=0;attempt<(options.attempts??20);attempt++){
    // Images/layout may update a node after the caller's snapshot. Verify the
    // current complete record, then reject a successful read if it changed again.
    // Never weaken the IndexedDB comparison or write an alternative snapshot.
    const current = options.readRecords?.() ?? records;
    const fingerprint = JSON.stringify([...current]);
    if(await (options.verify??confirmCanvasRecords)(key,current)){
      if(!options.readRecords || JSON.stringify([...options.readRecords()])===fingerprint)return;
    }
    await (options.wait??(ms=>new Promise<void>(resolve=>setTimeout(resolve,ms))))(300);
  }
  throw Error('画布修改尚未确认写入本机存储，已暂停后续操作（未提交新任务）。请检查保存状态或导出备份后继续');
  });
}
