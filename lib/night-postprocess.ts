import type {ProcessingResult} from './postprocess-queue.ts';
export type NightAttempt={profile:'safe'|'quality';segmented:boolean;segmentSeconds?:number;label:string};
export function nightAttempts(profile:'safe'|'quality',segmented=false):NightAttempt[]{
 if(segmented)return [{profile,segmented:true,label:'分段＋所选档位'},...(profile==='quality'?[{profile:'safe' as const,segmented:true,label:'分段＋16G 安全档'}]:[]),{profile:'safe',segmented:true,segmentSeconds:.5,label:'分段＋16G 安全（0.5秒）'}];
 return [{profile,segmented:false,label:'整段＋所选档位'},...(profile==='quality'?[{profile:'safe' as const,segmented:false,label:'整段＋16G 安全档'}]:[]),{profile:'safe',segmented:true,segmentSeconds:.5,label:'分段＋16G 安全（0.5秒）'}];
}
/** Retry only a returned definitive failure. Never retry uncertainty, user cancel or exceptions. */
export async function runNightAttempts(attempts:NightAttempt[],run:(attempt:NightAttempt,index:number)=>Promise<ProcessingResult>,stop:()=>boolean){
 for(let i=0;i<attempts.length;i++){if(stop())return 'cancelled' as const;const status=await run(attempts[i],i);if(status!=='failed')return status;}
 return 'failed' as const;
}
