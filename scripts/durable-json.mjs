import {promises as fs} from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';

const writes=new Map();
export const byteHash=bytes=>createHash('sha256').update(bytes).digest('hex');
export function parseJsonBytes(bytes){return JSON.parse(Buffer.from(bytes).toString('utf8').replace(/^\uFEFF/,''));}
const read=async file=>fs.readFile(file).catch(error=>{if(error.code==='ENOENT')return null;throw error;});
async function noLink(file){const st=await fs.lstat(file).catch(error=>{if(error.code==='ENOENT')return null;throw error;});if(st?.isSymbolicLink())throw Error('拒绝通过链接写入状态文件');}
/** fsync before rename, then verify bytes. Directory fsync is best effort on Windows. */
async function syncedReplace(file,bytes){
 await noLink(file);const temp=file+'.'+randomUUID()+'.tmp';
 const handle=await fs.open(temp,'wx');
 try{await handle.writeFile(bytes);await handle.sync();}finally{await handle.close();}
 const written=await fs.readFile(temp);if(!written.equals(bytes))throw Error('临时文件读回不一致，原文件未替换');
 await fs.rename(temp,file);
 const directory=await fs.open(path.dirname(file),'r').catch(error=>{if(['EPERM','EACCES','EISDIR','EINVAL'].includes(error.code))return null;throw error;});
 if(directory)try{await directory.sync().catch(error=>{if(!['EPERM','EACCES','EINVAL','EBADF'].includes(error.code))throw error;});}finally{await directory.close();}
 if(!(await fs.readFile(file)).equals(bytes))throw Error('状态文件替换后读回不一致');
}
export async function durableJson(file,value,options={}){
 const bytes=Buffer.isBuffer(value)?value:Buffer.from(typeof value==='string'?value:JSON.stringify(value,null,2));
 parseJsonBytes(bytes); // Never accept zero-filled or truncated request bodies.
 const prior=writes.get(file)??Promise.resolve();
 const work=prior.catch(()=>{}).then(async()=>{
  await noLink(file);const current=await read(file);let valid=true;
  if(current)try{parseJsonBytes(current);}catch{valid=false;}
  if(options.expectedCurrentSha256&&(!current||byteHash(current)!==options.expectedCurrentSha256))throw Error('状态文件已变化，拒绝覆盖');
  if(current&&!valid&&options.requireValidCurrent&&!options.allowCorruptReplace)throw Error('CORRUPT_INBOX_STATE:原记录损坏，保留现场，不允许用空状态覆盖');
  if(current?.equals(bytes))return {changed:false,sha256:byteHash(bytes),verified:true};
  if(options.backup){
   const parent=path.join(path.dirname(file),'.frameflow-state-backups');await noLink(parent);await fs.mkdir(parent,{recursive:true});
   const dir=path.join(parent,path.basename(file));await noLink(dir);await fs.mkdir(dir,{recursive:true});
   if(current){
    if(valid)await syncedReplace(path.join(dir,'previous-good.json'),current);
    else {const corrupt=path.join(dir,'corrupt-'+byteHash(current)+'.bin');if(!await read(corrupt))await syncedReplace(corrupt,current);}
   }
   await syncedReplace(path.join(dir,'last-good.json'),bytes);
  }
  await syncedReplace(file,bytes);return {changed:true,sha256:byteHash(bytes),verified:true};
 });
 writes.set(file,work);try{return await work;}finally{if(writes.get(file)===work)writes.delete(file);}
}
