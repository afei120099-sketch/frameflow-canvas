// Explicit live GPU smoke test: isolated browser; tiny synthetic clip; one named prompt only.
import assert from 'node:assert/strict';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {mkdtemp,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const [entry,executablePath,baseUrl='http://127.0.0.1:5173/']=process.argv.slice(2);
const queue=await(await fetch('http://127.0.0.1:8188/queue')).json();
if(queue.queue_running?.length||queue.queue_pending?.length)throw new Error('Live queue busy; skipped without submitting');
const temp=await mkdtemp(join(tmpdir(),'frameflow-film-smoke-'));
const helper=fileURLToPath(new URL('./rough-cut-fixtures.py',import.meta.url)),source=join(temp,'source.mp4');
await promisify(execFile)(process.env.FRAMEFLOW_PYAV_PYTHON||'python',['-c',"import runpy,sys; m=runpy.run_path(sys.argv[1]); m['make_clip'](sys.argv[2],320,180,24,0.5,110,(440,48000,'stereo'))",helper,source],{windowsHide:true});
const {chromium}=await import(pathToFileURL(entry).href),browser=await chromium.launch({executablePath,headless:true});
const context=await browser.newContext(),page=await context.newPage();
await context.route('**/__automation/**',r=>r.fulfill({status:503,body:'isolated smoke test'}));
await context.route('**/pending-shot-queue.json',r=>r.fulfill({status:404,body:''}));
await context.route('**/__film_fixture.mp4',async r=>r.fulfill({contentType:'video/mp4',body:await readFile(source)}));
try {
  await page.goto(baseUrl);
  const result=await page.evaluate(async()=>{
    const {comfyUIH3Adapter:adapter}=await import('/lib/comfyui/h3-adapter.ts');
    const {readMp4VideoTiming}=await import('/lib/video-fps.ts');
    const blob=await(await fetch('/__film_fixture.mp4')).blob();
    const id=crypto.randomUUID();
    let executionTiming;
    const result=await adapter.interpolate(blob,'frameflow-smoke-only.mp4',{promptId:id,onTiming:timing=>{executionTiming=timing;}});
    return {filename:result.filename,promptId:result.promptId,timing:await readMp4VideoTiming(result.video),size:result.video.size,executionTiming};
  });
  assert.equal(result.timing.fps,60);assert.equal(result.timing.frames,30);
  assert.equal(result.timing.width,320);assert.equal(result.timing.height,180);
  assert.ok(result.size>0);assert.ok(Object.keys(result.executionTiming.stages).length>0,"live stage events are captured");
  console.log('PASS actual FILM GPU smoke: 12 source frames at 24 FPS => 30 frames at 60 FPS, 0.5s unchanged, padded end trimmed correctly. Synthetic media only; not visual-quality acceptance.',result);
}finally {await browser.close();}
