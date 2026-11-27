import assert from 'node:assert/strict';import{readFileSync}from'node:fs';import{execFileSync}from'node:child_process';import vm from'node:vm';import ts from'typescript';
import{startVisibleStatusPoll}from'../lib/visible-status-poll.ts';
const source=readFileSync('app/canvas-workspace.tsx','utf8'),ast=ts.createSourceFile('workspace.tsx',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
const status=ast.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='LocalSystemStatus');
const effect=status.body.statements.find(n=>ts.isExpressionStatement(n)&&ts.isCallExpression(n.expression)&&n.expression.expression.getText(ast)==='useEffect');
assert.ok(effect.getText(ast).includes('startVisibleStatusPoll'));
class Surface extends EventTarget{hidden=false;}
const doc=new Surface(),win=new Surface(),requests=[],updates=[];
let now=0,serial=0,online=false;const timers=new Map();
const schedule=(callback,delay)=>{const id=++serial;timers.set(id,{at:now+delay,callback});return id;};const clear=id=>timers.delete(id);
const flush=()=>new Promise(resolve=>setImmediate(resolve));
async function advance(ms){const target=now+ms;for(;;){const due=[...timers].filter(([,t])=>t.at<=target).sort((a,b)=>a[1].at-b[1].at)[0];if(!due)break;now=due[1].at;timers.delete(due[0]);due[1].callback();await flush();}now=target;await flush();}
let cleanup;
const context=vm.createContext({comfyUIH3Adapter:{systemStats:async()=>(await context.fetch('/comfyui/system_stats')).json(),queueSnapshot:async()=>(await context.fetch('/comfyui/queue')).json()},document:doc,window:win,AbortSignal,Error,Promise,refreshStatus:{current:null},useEffect:fn=>{cleanup=fn();},
startVisibleStatusPoll:(task,options)=>startVisibleStatusPoll(task,{...options,schedule,clear}),
fetch:async url=>{requests.push({url,at:now});if(url==='/__local_status')return{ok:true,json:async()=>({cpuPercent:42})};if(!online)throw Error('fake offline');return{ok:true,json:async()=>url.endsWith('queue')?{queue_running:[1],queue_pending:[2,3]}:{devices:[{name:'fake-GPU'}]}};
},setLocal:value=>updates.push(['local',value]),setComfy:value=>updates.push(['comfy',value]),setQueueCount:value=>updates.push(['queue',value])});
vm.runInContext(ts.transpileModule(effect.getText(ast),{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,context);await flush();await advance(600000);
const local=requests.filter(r=>r.url==='/__local_status'),comfy=requests.filter(r=>r.url.startsWith('/comfyui/'));
assert.ok(local.length>=300);assert.ok(comfy.length<=30);assert.equal(comfy.filter(r=>r.url.endsWith('queue')).length,0);
assert.deepEqual(comfy.slice(0,5).map(r=>r.at),[0,15000,45000,75000,105000]);
const count=requests.length;doc.hidden=true;doc.dispatchEvent(new Event('visibilitychange'));await advance(60000);assert.equal(requests.length,count,'all status polling paused while hidden');
online=true;doc.hidden=false;doc.dispatchEvent(new Event('visibilitychange'));await flush();
assert.equal(updates.at(-1)[0],'queue');assert.equal(updates.at(-1)[1],3);const returnedAt=now;await advance(5000);assert.ok(requests.some(r=>r.url.endsWith('system_stats')&&r.at===returnedAt+5000));
const beforeCleanup=updates.length;cleanup();await advance(60000);assert.equal(updates.length,beforeCleanup);assert.equal(timers.size,0);
let releases,concurrent=0;const pendingDoc=new Surface(),pendingWin=new Surface();const loop=startVisibleStatusPoll(()=>{concurrent++;return new Promise(resolve=>{releases=resolve;});},{document:pendingDoc,window:pendingWin,delays:[2000,5000],schedule,clear});
for(let i=0;i<5;i++)pendingWin.dispatchEvent(new Event('focus'));assert.equal(concurrent,1);loop.stop();releases(true);await flush();assert.equal(timers.size,0,'late request completion after stop cannot schedule another');
const audit=readFileSync('components/canvas/canvas-tools.tsx','utf8');assert.match(audit,/document.hidden\?60000:30000/);assert.match(audit,/if\(!live\|\|pending\)return/);assert.doesNotMatch(audit,/if\(document.hidden\)return/);
const prior=execFileSync('git',['show','1f33b62:components/canvas/canvas-tools.tsx'],{encoding:'utf8'});
const auditBody=text=>text.slice(text.indexOf('    const key="automatic-audit-enabled-since-v1"'),text.indexOf('   }catch{/* Manual check'));
assert.ok(audit.indexOf('    const key="automatic-audit-enabled-since-v1"')>0);assert.ok(prior.indexOf('    const key="automatic-audit-enabled-since-v1"')>0);
assert.equal(auditBody(audit),auditBody(prior),'actual audit/seen filtering unchanged');
const review=ast.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='H3SubmissionInfo');
const reviewEffect=review.body.statements.find(n=>ts.isExpressionStatement(n)&&ts.isCallExpression(n.expression)&&n.expression.expression.getText(ast)==='useEffect'&&n.getText(ast).includes('roleWatchKey'));
let reviewCleanup,reviewCheck,revision=0,roleReads=0,roleName='original';const reviewDoc=new Surface(),reviewWin=new Surface();
const reviewContext=vm.createContext({useEffect:fn=>{reviewCleanup=fn();},document:reviewDoc,window:reviewWin,roleWatchKey:'["role:test"]',JSON,Promise,setInterval:(fn,ms)=>{assert.equal(ms,5000);reviewCheck=fn;return 1;},clearInterval(){},setRevision:fn=>{revision=fn(revision);},getRole:async()=>{roleReads++;return{roleId:'role:test',displayName:roleName};}});
vm.runInContext(ts.transpileModule(reviewEffect.getText(ast),{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,reviewContext);await flush();assert.equal(roleReads,1);roleName='updated';reviewCheck();await flush();assert.equal(revision,1);reviewDoc.hidden=true;reviewCheck();await flush();assert.equal(roleReads,2);reviewDoc.hidden=false;reviewDoc.dispatchEvent(new Event('visibilitychange'));await flush();assert.equal(roleReads,3);reviewCleanup();reviewCheck();await flush();assert.equal(roleReads,3);
const auditAst=ts.createSourceFile('tools.tsx',audit,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);let auditEffect;
const find=node=>{if(ts.isCallExpression(node)&&node.expression.getText(auditAst)==='useEffect'&&node.arguments[0]?.getText(auditAst).includes('automatic-audit-enabled-since-v1'))auditEffect=node.getText(auditAst);ts.forEachChild(node,find);};find(auditAst);assert.ok(auditEffect);
let auditCleanup,auditReads=0,audits=0;const auditDoc=new Surface(),auditAssets=[];
const auditContext=vm.createContext({useEffect:fn=>{auditCleanup=fn();},document:auditDoc,Set,Date,getMeta:async()=>1,putMeta:async()=>{},listAssets:async()=>{auditReads++;return auditAssets;},auditAsset:async()=>{audits++;},setTimeout:schedule,clearTimeout:clear});
vm.runInContext(ts.transpileModule(auditEffect,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,auditContext);await flush();assert.equal(auditReads,1);assert.equal([...timers.values()][0].at-now,30000);
auditAssets.push({assetId:'test-only-video',createdAt:2,origin:'generated'});auditDoc.hidden=true;auditDoc.dispatchEvent(new Event('visibilitychange'));assert.equal([...timers.values()][0].at-now,60000);await advance(60000);assert.equal(audits,1,'background audit still runs while hidden');await advance(60000);assert.equal(audits,1,'seen set still suppresses repeat audit');auditDoc.hidden=false;auditDoc.dispatchEvent(new Event('visibilitychange'));assert.equal([...timers.values()][0].at-now,30000);auditCleanup();assert.equal(timers.size,0);
assert.equal(readFileSync('components/canvas/telegram-bridge.tsx','utf8'),execFileSync('git',['show','1f33b62:components/canvas/telegram-bridge.tsx'],{encoding:'utf8'}),'Telegram unchanged');
const clockBody=text=>text.slice(text.indexOf('const clockListeners='),text.indexOf('export function useRunTiming'));
assert.ok(clockBody(readFileSync('components/canvas/run-recovery-view.tsx','utf8')).length>500);
assert.equal(clockBody(readFileSync('components/canvas/run-recovery-view.tsx','utf8')),clockBody(execFileSync('git',['show','1f33b62:components/canvas/run-recovery-view.tsx'],{encoding:'utf8'})),'shared Run clock unchanged; J only adds read-failure state in the consumer hook');
console.log(`PASS H actual effects: ${local.length} local vs ${comfy.length} offline health requests / virtual 10 min; backoff/visibility/focus/overlap/cleanup; 5s role refresh; 30/60s audit continues hidden, seen unchanged; Telegram/shared clock unchanged`);
