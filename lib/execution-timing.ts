export interface ExecutionTiming { executionMs?:number; startedAt?: number; completedAt?: number; stages: Record<string, number>; source?: 'observed' | 'history' }
export function historyExecutionTiming(entry: { status?: unknown }): ExecutionTiming {
  const status=entry.status as {messages?: [string,{timestamp?:number}][]}|undefined;
  const messages=status?.messages??[];
  const startedAt=messages.find(([type])=>type==='execution_start')?.[1]?.timestamp;
  const completedAt=[...messages].reverse().find(([type])=>['execution_success','execution_error','execution_interrupted'].includes(type))?.[1]?.timestamp;
  const valid=(n:unknown):n is number=>typeof n==='number' && Number.isFinite(n) && n>0;
  return {stages:{},...(valid(startedAt)?{startedAt}:{}),...(valid(completedAt)?{completedAt}:{}),source:'history'};
}
/** Wall-clock observations, not profiler timings; polling/WS loss cannot be called a measured GPU phase. */
export function createExecutionClock(now=Date.now) {
  let current='',since=0,startedAt:number|undefined;
  const stages:Record<string,number>={};
  return {
    observe(status:string) {
      const phase=status==='loading'?'准备/加载':status==='running'?'采样':status==='decoding'?'解码/保存':'';
      if(!phase || phase===current)return;
      const t=now(); if(current)stages[current]=(stages[current]??0)+Math.max(0,t-since);
      startedAt??=t; current=phase;since=t;
    },
    finish(exact:Partial<ExecutionTiming>={}):ExecutionTiming {
      const t=exact.completedAt??now();
      if(current){stages[current]=(stages[current]??0)+Math.max(0,t-since);current='';}
      return {startedAt,completedAt:t,...exact,executionMs:exact.startedAt && exact.completedAt?Math.max(0,exact.completedAt-exact.startedAt):Object.values(stages).reduce((a,b)=>a+b,0),stages:{...stages},source:Object.keys(stages).length?'observed':'history'};
    },
  };
}
