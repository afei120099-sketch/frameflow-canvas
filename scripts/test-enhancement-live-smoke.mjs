// Explicit live GPU smoke: isolated storage; one tiny HD stage and one FILM stage, no production media.
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
const temp=await mkdtemp(join(tmpdir(),'frameflow-enhancement-smoke-'));
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
    const {readMp4VideoTiming}=await import('/lib/video-fps.ts');
    const {newEnhancementCheckpoint}=await import('/lib/enhancement-pipeline.ts');
    const {prepareSegmentedUpscale}=await import('/lib/segmented-upscale.ts');
    const {boundInterpolationPlan}=await import('/lib/enhancement-memory.ts');
    const {saveEnhancement,resumeEnhancement}=await import('/lib/resume-enhancement.ts');
    const {storeLocalVideo}=await import('/lib/local-video-store.ts');
    const {registerAsset,createRun}=await import('/lib/production-records.ts');
    const {snapshotUpscale60}=await import('/lib/production-snapshots.ts');
    const blob=await(await fetch('/__film_fixture.mp4')).blob();
    const source=await storeLocalVideo(blob,'smoke-input.mp4');
    const asset=await registerAsset({kind:'video',origin:'imported',filename:'smoke-input.mp4',mimeType:'video/mp4',storageReference:source,sourceRunId:null,width:320,height:180,duration:.5,fps:24});
    const plan=boundInterpolationPlan(await prepareSegmentedUpscale(blob,'smoke-input.mp4',.5,undefined,{width:1920,height:1080},{seconds:1,contextFrames:8}));
    const snapshot=await snapshotUpscale60(24,320,180,{width:1920,height:1080});
    const run=await createRun({...snapshot,inputAssetIds:[asset.assetId],rawPrompt:null,finalPrompt:null,seed:null});
    await saveEnhancement(newEnhancementCheckpoint({runId:run.runId,plan,combined:true,profile:'safe',originalSource:source,originalName:'smoke-input.mp4'}));
    const stages=[];
    const result=await resumeEnhancement(run,{onUpdate:update=>{if(update.stage && stages.at(-1)!==update.stage)stages.push(update.stage);}});
    return {filename:result.filename,promptId:result.promptId,timing:await readMp4VideoTiming(result.video),size:result.video.size,stages};

  });
  assert.equal(result.timing.fps,60);assert.equal(result.timing.frames,30);
  assert.equal(result.timing.width,1920);assert.equal(result.timing.height,1080);
  assert.ok(result.size>0);
  console.log('PASS actual SeedVR2 safe-profile + FILM pipeline: 320x180 24FPS ->1920x1080 60FPS, 30 frames, 0.5s, one final merged output. Synthetic media only, not human visual-quality acceptance.',result);
}finally {await browser.close();}

