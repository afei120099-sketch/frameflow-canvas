import type {Plugin} from 'vite';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import path from 'node:path';
import {PYAV_PYTHON} from './pyav-runtime';

/** Local CPU compositor. Only data images enter; only fixed output filenames leave. */
export function coverPlugin():Plugin{
 return {name:'frameflow-cover',configureServer(server){
  const root=path.resolve(server.config.root,'runtime/covers');let active=0;
  server.middlewares.use(async(req,res,next)=>{
   if(!req.url?.startsWith('/__cover/'))return next();
   const reply=(status:number,data:unknown)=>{res.statusCode=status;res.setHeader('Content-Type','application/json; charset=utf-8');res.end(JSON.stringify(data));};
   if(!/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(req.headers.host??'')||!/^(127\.0\.0\.1|::1|::ffff:127\.0\.0\.1)$/.test(req.socket.remoteAddress??''))return reply(403,{error:'仅本机可调用封面处理'});
   if(req.headers.origin&&req.headers.origin!==`http://${req.headers.host}`)return reply(403,{error:'禁止跨站封面请求'});
   try{
    const url=new URL(req.url,'http://localhost');
    const file=url.pathname.match(/^\/__cover\/jobs\/([a-f0-9-]{36})\/(guide\.png|(?:original|generated)-face-[12]\.png|base\.png|title\.png|final\.png|repair-mask\.png|cutout\.png|raw-cutout\.png|alpha\.png|check-(?:black|white|gray)\.png|manifest\.json)$/);
    if(req.method==='GET'&&file){const data=await readFile(path.join(root,file[1],file[2]));res.setHeader('Content-Type',file[2].endsWith('.json')?'application/json':'image/png');res.setHeader('Cache-Control','private, max-age=31536000, immutable');res.end(data);return;}
    if(req.method!=='POST'||url.pathname!=='/__cover/jobs')return reply(404,{error:'没有此封面接口'});
    if(active>=1)return reply(409,{error:'CPU封面处理忙，请稍后再试'});
    if(!req.headers['content-type']?.includes('application/json'))return reply(415,{error:'需要JSON请求'});
    active++;try{
     let size=0;const chunks:Buffer[]=[];
     for await(const chunk of req){size+=chunk.length;if(size>80*1024*1024)throw Error('图片总量超过80MB，请先缩小');chunks.push(Buffer.from(chunk));}
     const plan=JSON.parse(Buffer.concat(chunks).toString('utf8'));
     if(!['cutout','compose','director-guide','identity-cards'].includes(plan.operation))throw Error('未知封面操作');
     const jobId=randomUUID(),dir=path.join(root,jobId);await mkdir(dir,{recursive:true});await writeFile(path.join(dir,'plan.json'),JSON.stringify(plan));
     await new Promise<void>((resolve,reject)=>{
      const child=spawn(PYAV_PYTHON,['-X','faulthandler',path.resolve(server.config.root,'scripts/cover-compose.py'),path.join(dir,'plan.json'),dir],{windowsHide:true});let stderr='';
      const timer=setTimeout(()=>{child.kill();reject(Error('CPU封面处理超过120秒，已保留输入，请缩小图片后重试'));},120000);
      child.stdout.resume();child.stderr.on('data',data=>{stderr=(stderr+data.toString('utf8')).slice(-6000);});
      child.on('error',e=>{clearTimeout(timer);reject(e);});child.on('exit',code=>{clearTimeout(timer);let detail=stderr.trim();try{detail=JSON.parse(detail.split('\n').at(-1)??'').error??detail;}catch{}code===0?resolve():reject(Error(detail||`封面处理失败（${code}）`));});
     });
     const manifest=JSON.parse(await readFile(path.join(dir,'manifest.json'),'utf8'));reply(200,{jobId,...manifest});
    }finally{active--;}
   }catch(error){reply(400,{error:error instanceof Error?error.message:String(error)});}
  });
 }};
}
