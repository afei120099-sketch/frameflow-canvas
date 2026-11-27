// 浏览器测试：AI 作歌节点（MiniMax Music 3）在真实页面里建节点、填词、出结果、放成声音节点。
//
// 默认直接跳过（退出码 0），不打开任何页面。原因（2026-11-11 查过）：
// 1. 它要一个跑着的画布开发服务器。开发服务器自己会连真 ComfyUI：/comfyui 代理和进度插件
//    （scripts/comfy-progress-vite-plugin.ts）都写死 lib/comfyui/config.ts 的 127.0.0.1:8188，
//    浏览器里拦请求拦不到服务器那一侧。
// 2. 页面的 /api/inbox 在 5173–5177 以外的端口回落到 5193，也就是用户正在用的收件箱助手；
//    回收站 5189、收件箱认领 / 日志 8791、页面互传 5198 都是写死的端口。
// 3. 画布页面一打开就跑收件箱调度。规矩：自动化测试不在用户浏览器里打开真实画布页面。
// 所以在这些地址能整体换成测试用的之前，做不到「不碰真画布、真收件箱、真 ComfyUI」，这里不硬修。
//
// 旧版本后半段测的「用这首歌做视频 → 原音轨锁定视频」已于 2026-11-10 停用（9800c44），已删掉，
// 现在反过来检查这个按钮不存在。
//
// 真要跑：用户自己准备好一个完全隔离的画布（独立端口、临时收件箱目录、ComfyUI 换成假的），然后
//   FRAMEFLOW_ISOLATED_CANVAS_URL=http://127.0.0.1:<端口>/ node scripts/test-media-workshop-canvas.mjs <playwright 入口> <浏览器 exe>
// 即使这样，脚本也只放行这个地址本身的页面和模块文件；/comfyui 用假数据回答；/api、/__automation
// 和任何别的端口、别的网址一律拦掉。5173–5177 一律拒绝。
import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';

const isolated=process.env.FRAMEFLOW_ISOLATED_CANVAS_URL;
if(!isolated){
  console.log('SKIP media-workshop-canvas: 需要一个和用户画布完全隔离的画布页面（独立端口 + 临时收件箱 + 假 ComfyUI）。开发服务器自身会连 127.0.0.1:8188 和 5193，做不到隔离，所以默认不跑。详见脚本开头说明。');
  process.exit(0);
}
const baseUrl=new URL(isolated);
const LIVE_PORTS=new Set(['5173','5174','5175','5176','5177','5193','5194','8188','8189']);
if(LIVE_PORTS.has(baseUrl.port||'80'))throw Error(`拒绝运行：${baseUrl.origin} 是用户在用的画布 / 收件箱 / ComfyUI 端口`);
const [entry,executablePath]=process.argv.slice(2);
if(!entry||!executablePath)throw Error('用法：FRAMEFLOW_ISOLATED_CANVAS_URL=... node scripts/test-media-workshop-canvas.mjs <playwright 入口> <浏览器 exe>');

const {chromium}=await import(pathToFileURL(entry).href);
const browser=await chromium.launch({executablePath,headless:true});
const context=await browser.newContext({viewport:{width:1600,height:1100}});
const page=await context.newPage();const errors=[];const blocked=[];
page.on('pageerror',e=>errors.push(e.message));
// A one-second silent WAV fixture tests browser decoding only, not generated music quality.
const wave=Buffer.alloc(44+48000*2);wave.write('RIFF',0);wave.writeUInt32LE(wave.length-8,4);wave.write('WAVEfmt ',8);wave.writeUInt32LE(16,16);wave.writeUInt16LE(1,20);wave.writeUInt16LE(1,22);wave.writeUInt32LE(48000,24);wave.writeUInt32LE(96000,28);wave.writeUInt16LE(2,32);wave.writeUInt16LE(16,34);wave.write('data',36);wave.writeUInt32LE(48000*2,40);
let posts=0,sent,promptId='';
// Deny by default: only this origin's page/module files pass; /comfyui is mocked; everything else is aborted.
await context.route('**/*',async route=>{
  const url=new URL(route.request().url());
  if(url.origin!==baseUrl.origin||url.pathname.startsWith('/api/')||url.pathname.startsWith('/__automation')){blocked.push(url.origin+url.pathname);return route.abort();}
  if(!url.pathname.startsWith('/comfyui/'))return route.continue();
  const path=url.pathname.replace('/comfyui','');
  const json=x=>route.fulfill({contentType:'application/json',body:JSON.stringify(x)});
  if(path.startsWith('/object_info/')){const type=path.split('/').at(-1);return json({[type]:{input:{required:{
    unet_name:[['minimax_music3_dit_fp16.safetensors']],
    clip_name:[['minimax_music3_text_encoder_pruned_int8_convrot.safetensors']],
    vae_name:[['minimax_music3_dav.safetensors']],
  }}}});}
  if(path==='/prompt'){posts++;sent=route.request().postDataJSON();promptId=sent.prompt_id;return json({prompt_id:promptId});}
  if(path.startsWith('/history/'))return json({[promptId]:{status:{completed:true},outputs:{'9':{audio:[{filename:'test-song.mp3'}]}}}});
  if(path==='/queue')return json({queue_running:[],queue_pending:[]});
  if(path==='/view')return route.fulfill({contentType:'audio/mpeg',body:wave});
  return json({});
});
try{
  await page.goto(baseUrl.href);
  const add=page.getByRole('button',{name:'添加素材或节点',exact:true});await add.waitFor({timeout:60000});await add.click();
  await page.locator('.add-dock-menu').getByRole('button',{name:'AI 作歌',exact:true}).click();
  const song=page.locator('.tl-shape[data-shape-type="music-node"]');await song.waitFor();
  await song.getByLabel('作歌描述',{exact:true}).fill('Warm acoustic pop');
  await song.getByLabel('作歌歌词',{exact:true}).fill('你好世界');
  await song.getByLabel('只生成纯音乐').check();
  await song.getByRole('button',{name:'生成歌曲／配乐',exact:true}).click();
  await song.getByText('作歌完成',{exact:true}).waitFor();
  assert.equal(posts,1);assert.equal(sent.prompt['4'].inputs.lyrics,'');assert.equal(sent.prompt['2'].inputs.device,'cpu');
  await song.getByRole('button',{name:'放为声音节点',exact:true}).click();
  assert.equal(await page.locator('.tl-shape[data-shape-type="audio-node"]').count(),1);
  // 原音轨锁定视频 retired 2026-11-10: the music node must not offer it any more.
  assert.equal(await song.getByRole('button',{name:'用这首歌做视频',exact:true}).count(),0);
  assert.deepEqual(errors,[]);
  console.log(`PASS isolated UI: Music3 node, lyrics/instrumental, mocked output, audio placement, no retired 原音轨锁定 button; ${blocked.length} outside requests blocked; no real GPU request`);
}catch(e){console.error('Page:',(await page.locator('body').innerText()).slice(-5000));throw e;}finally{await browser.close();}
