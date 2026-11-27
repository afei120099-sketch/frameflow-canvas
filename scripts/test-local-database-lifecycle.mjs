import assert from'node:assert/strict';import{readFileSync}from'node:fs';import vm from'node:vm';import ts from'typescript';import{openLocalDatabase}from'../lib/local-database-open.ts';
import{saveNodeForRun}from'../lib/run-recovery.ts';import{COMMUNITY_SAVE_NODE_ID}from'../lib/comfyui/experimental/h3-community.ts';import{dialogueAudioIds,DIALOGUE_AUDIO_PREFIX}from'../lib/h3-dialogue.ts';
const original=globalThis.indexedDB,requests=[];let throwOnOpen=false;
const flush=()=>new Promise(resolve=>setImmediate(resolve)),read=p=>readFileSync(p,'utf8').replaceAll('\r\n','\n');
globalThis.indexedDB={open(name,version){if(throwOnOpen)throw new DOMException('blocked by policy','SecurityError');const db={closed:0,created:[],objectStoreNames:{contains:()=>false},createObjectStore(name,options){this.created.push([name,options]);return{createIndex(){}};},close(){this.closed++;}};const request={name,version,result:db,aborted:0,transaction:{abort(){request.aborted++;}}};requests.push(request);return request;}};
try{
 const specs=[['lib/production-records.ts','openDatabase',{DATABASE_NAME:'frameflow-production-records',ASSETS:'assets',RUNS:'runs',SHOTS:'shots',META:'meta'},2],['lib/role-records.ts','openDatabase',{DATABASE:'frameflow-role-records',STORE:'roles'},1],['lib/local-video-store.ts','openDatabase',{DATABASE_NAME:'frameflow-local-media',DATABASE_VERSION:2,VIDEO_STORE:'videos',IMAGE_STORE:'images'},2],['lib/local-video-store.ts','openAudioDatabase',{AUDIO_DATABASE_NAME:'frameflow-local-audio',AUDIO_STORE:'audios'},1]];
 for(const[file,name,constants,version]of specs){
  const source=read(file),ast=ts.createSourceFile('db.ts',source,ts.ScriptTarget.Latest,true),fn=ast.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text===name);assert.ok(fn);
  const context=vm.createContext({openLocalDatabase,...constants});const opener=vm.runInContext(ts.transpileModule('let databasePromise=null,audioDatabasePromise=null;'+fn.getText(ast)+';'+name+';',{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,context);
  let promise=opener();const blocked=assert.rejects(promise,/其他页面占用/);await flush();const first=requests.at(-1);assert.equal(first.version,version);first.onblocked();await blocked;
  const replacement=opener();await flush();const second=requests.at(-1);assert.notEqual(first,second);
  first.onupgradeneeded();assert.equal(first.aborted,1);assert.equal(first.result.created.length,0,'abandoned request must not create stores later');first.onsuccess();assert.equal(first.result.closed,1);assert.equal(opener(),replacement,'late success must not poison replacement cache');
  second.onupgradeneeded();assert.ok(second.result.created.length>0);second.onsuccess();assert.equal(await replacement,second.result);assert.equal(opener(),replacement);second.result.onversionchange();assert.equal(second.result.closed,1);
  const thirdPromise=opener();const thirdFailure=assert.rejects(thirdPromise,/mock open error/);await flush();const third=requests.at(-1);assert.notEqual(second,third);third.error=Error('mock open error');third.onerror();await thirdFailure;
  throwOnOpen=true;await assert.rejects(opener(),/blocked by policy/);throwOnOpen=false;
  const finalPromise=opener();await flush();const final=requests.at(-1);final.onsuccess();assert.equal(await finalPromise,final.result);
 }
 for(const workflowOptionId of ['community-ultimate','community-dialogue'])assert.equal(saveNodeForRun({capabilityId:'h3_ref2va',parameters:{workflowOptionId}}),COMMUNITY_SAVE_NODE_ID);
 assert.equal(COMMUNITY_SAVE_NODE_ID,'148');assert.equal(DIALOGUE_AUDIO_PREFIX,'audio:');assert.deepEqual(dialogueAudioIds([{roleId:'',voice:'audio:声音-id',text:'x'},{roleId:'',voice:'audio:声音-id',text:'y'},{roleId:'r',voice:'audio:not-unbound',text:'z'}]),['声音-id']);
 console.log('PASS K all 4 actual database openers: blocked rejects, abandoned upgrade abort/no schema creation, late success closes without cache poisoning, versionchange closes/reopens, async+sync failures recover; save ID and audio prefix semantics');
}finally{if(original===undefined)delete globalThis.indexedDB;else globalThis.indexedDB=original;}
