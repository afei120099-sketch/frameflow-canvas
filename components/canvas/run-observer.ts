'use client';
import { createRunObserver } from '@/lib/run-observer';
import { getRun,listRuns,RUN_CHANGE_CHANNEL } from '@/lib/production-records';
export const nodeRuns=createRunObserver({list:listRuns,get:getRun,listen:changed=>{
  const channel=typeof BroadcastChannel==='undefined'?null:new BroadcastChannel(RUN_CHANGE_CHANNEL);
  const message=(event:MessageEvent)=>changed(typeof event.data?.runId==='string'?event.data.runId:undefined);
  const local=(event:Event)=>changed((event as CustomEvent<{runId?:string}>).detail?.runId);
  channel?.addEventListener('message',message);window.addEventListener(RUN_CHANGE_CHANNEL,local);
  return()=>{channel?.close();window.removeEventListener(RUN_CHANGE_CHANNEL,local);};
}});
