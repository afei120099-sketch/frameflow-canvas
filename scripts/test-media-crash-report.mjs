import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {RoughCutJobs} from './rough-cut-jobs.ts';
const root=await mkdtemp(join(tmpdir(),'frameflow-crash-report-test-'));
const jobs=new RoughCutJobs({python:'unused',script:new URL('./rough-cut.py',import.meta.url).pathname,tempRoot:root});
try {
  // Exercise the reporting path without crashing Python or submitting a GPU task.
  const job={stage:{stage:'clip',index:2},clips:[{filename:'a.mp4'},{filename:'b.mp4'}]};
  const error=jobs.parseError(job,'Windows fatal exception: access violation\nstack evidence',3221225477);
  assert.match(error.message,/0xC0000005/);
  assert.equal(error.clip,2);assert.equal(error.filename,'b.mp4');assert.equal(error.stage,'clip');
  assert.match(error.detail,/stack evidence/);
  const backend=await readFile(new URL('./rough-cut-jobs.ts',import.meta.url),'utf8');
  assert.match(backend,/"-X", "faulthandler"/);
  assert.match(backend,/frameflow-media-diagnostics/);
  assert.ok(backend.indexOf('job.error.logPath=logPath')<backend.indexOf('(job as Job).state'));
  const client=await readFile(new URL('../lib/segmented-upscale.ts',import.meta.url),'utf8');
  assert.match(client,/error\?\.logPath/);assert.match(client,/第\$\{error.clip\}段/);
  const py=await readFile(new URL('./rough-cut.py',import.meta.url),'utf8');
  assert.doesNotMatch(py,/thread_type = "AUTO"/);
  assert.match(py,/pictures.close\(\)/);assert.match(py,/sound.close\(\)/);
  console.log('PASS crash code, stage, filename, traceback, persistent-log and bounded-thread wiring; no GPU tasks');
} finally {await jobs.disposeAll();await rm(root,{recursive:true,force:true});}
