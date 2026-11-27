import type {Plugin} from 'vite';
import {COMFYUI_SERVER_URL} from '../lib/comfyui/config';
/** Same-origin SSE relay. Node owns the upstream WS, so browser Origin/duplicate upgrade handlers
 * cannot break progress. Fixed localhost target; read-only events, no model/queue mutations. */
export function comfyProgressPlugin():Plugin {
 return {name:'frameflow-comfy-progress',configureServer(server){
  const sockets=new Set<WebSocket>();
  server.httpServer?.once('close',()=>{for(const socket of sockets)socket.close();sockets.clear();});
  server.middlewares.use((request,response,next)=>{
   const path=new URL(request.url??'/', 'http://localhost');
   if(path.pathname!=='/__comfy_progress')return next();
   if(request.method!=='GET'){response.writeHead(405);response.end();return;}
   const id=path.searchParams.get('clientId')??'';
   if(!/^[a-f0-9-]{36}$/i.test(id)){response.writeHead(400);response.end('Invalid client ID');return;}
   if(sockets.size>=32){response.writeHead(503);response.end('Too many progress clients');return;}
   response.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache, no-transform','Connection':'keep-alive','X-Accel-Buffering':'no'});
   response.write(': connected\n\n');
   const url=new URL('/ws',COMFYUI_SERVER_URL);url.protocol=url.protocol==='https:'?'wss:':'ws:';url.searchParams.set('clientId',id);
   const socket=new WebSocket(url);sockets.add(socket);
   const heartbeat=setInterval(()=>{if(!response.destroyed)response.write(': keep-alive\n\n');},15000);
   const cleanup=()=>{clearInterval(heartbeat);sockets.delete(socket);socket.close();};
   response.once('close',cleanup);
   socket.addEventListener('message',event=>{
    if(typeof event.data!=='string'||response.destroyed)return;
    try{response.write(`data: ${JSON.stringify(JSON.parse(event.data))}\n\n`);}catch{/* Ignore binary/malformed previews. */}
   });
   socket.addEventListener('error',()=>{if(!response.destroyed)response.end();});
   socket.addEventListener('close',()=>{if(!response.destroyed)response.end();});
  });
 }};
}
