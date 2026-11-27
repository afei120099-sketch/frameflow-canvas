import assert from 'node:assert/strict';
import { buildFluxSchnell, runFluxSchnell, FLUX_CHECKPOINT } from '../lib/comfyui/flux-schnell.ts';
const input = { prompt: 'a portrait', width: 1024, height: 1536, seed: 42 };
const graph = buildFluxSchnell(input);
assert.equal(Object.keys(graph).length, 7);
assert.equal(graph['1'].inputs.ckpt_name, FLUX_CHECKPOINT);
assert.equal(graph['3'].class_type, 'EmptySD3LatentImage');
assert.equal(graph['5'].inputs.steps, 4);
assert.equal(graph['5'].inputs.cfg, 1);
const custom = buildFluxSchnell({ ...input, steps: 6, cfg: 1.5, sampler: 'heun', scheduler: 'karras', denoise: 0.9 });
assert.equal(custom['5'].inputs.steps, 6);
assert.equal(custom['5'].inputs.cfg, 1.5);
assert.equal(custom['5'].inputs.sampler_name, 'heun');
assert.equal(custom['5'].inputs.scheduler, 'karras');
assert.equal(custom['5'].inputs.denoise, 0.9);
assert.throws(() => buildFluxSchnell({ ...input, steps: 0 }));
assert.throws(() => buildFluxSchnell({ ...input, cfg: NaN }));
assert.throws(() => buildFluxSchnell({ ...input, denoise: 1.1 }));
const imgGraph = buildFluxSchnell({ ...input, imageName: 'test/source.png', denoise: 0.65 });
assert.equal(imgGraph['3'].class_type, 'VAEEncode');
assert.deepEqual(imgGraph['3'].inputs.pixels, ['9', 0]);
assert.equal(imgGraph['8'].inputs.image, 'test/source.png');
assert.equal(imgGraph['9'].inputs.width, 1024);
assert.equal(imgGraph['5'].inputs.denoise, 0.65);
for (const node of Object.values(imgGraph)) for (const value of Object.values(node.inputs)) if (Array.isArray(value)) assert.ok(imgGraph[value[0]], `broken image link ${value}`);
for (const node of Object.values(graph)) for (const value of Object.values(node.inputs)) if (Array.isArray(value)) assert.ok(graph[value[0]], `broken link ${value}`);
assert.throws(() => buildFluxSchnell({ ...input, prompt: '' }));
assert.throws(() => buildFluxSchnell({ ...input, width: 1025 }));
let submitted = 0;
const mock = async (url, init) => {
  if (url.includes('/object_info')) return Response.json({ CheckpointLoaderSimple: { input: { required: { ckpt_name: [[FLUX_CHECKPOINT]] } } } });
  if (url.endsWith('/queue')) return Response.json({ queue_running: [], queue_pending: [] });
  if (url.endsWith('/prompt')) { submitted++; assert.equal(JSON.parse(init.body).prompt['5'].inputs.steps, 4); return Response.json({ prompt_id: 'mock-flux' }); }
  if (url.includes('/history/')) return Response.json({ 'mock-flux': { status: { completed: true }, outputs: { '7': { images: [{ filename: 'flux.png', type: 'output' }] } } } });
  if (url.includes('/view?')) return new Response(new Blob(['mock png'], { type: 'image/png' }));
  throw Error(url);
};
const result = await runFluxSchnell(input, { fetch: mock, pollMs: 0 });
assert.equal(result.filename, 'flux.png');
assert.equal(submitted, 1);
await assert.rejects(runFluxSchnell(input, { fetch: async (url, init) => url.endsWith('/queue') ? Response.json({ queue_running: [['existing']], queue_pending: [] }) : mock(url, init) }), /还有任务/);
assert.equal(submitted, 1);
await assert.rejects(runFluxSchnell(input, { fetch: async (url, init) => url.includes('/history/') ? Response.json({ 'mock-flux': { status: { status_str: 'error', messages: [['execution_error', { exception_message: 'OOM' }]] } } }) : mock(url, init) }), /OOM/);
console.log('Flux 7-node graph, 4 steps, mock output, queue guard and error reporting passed. No GPU job submitted.');
let uploads = 0, imageSubmits = 0;
const imageMock = async (url, init) => {
  if (url.endsWith('/upload/image')) {
    uploads++;
    assert.equal(init.body.get('overwrite'), 'false');
    assert.ok(init.body.get('image').size > 0);
    return Response.json({name:'source.png',subfolder:'mock'});
  }
  if (url.endsWith('/prompt')) {
    imageSubmits++;
    const submittedGraph=JSON.parse(init.body).prompt;
    assert.equal(submittedGraph['3'].class_type,'VAEEncode');
    assert.equal(submittedGraph['8'].inputs.image,'mock/source.png');
    assert.equal(submittedGraph['5'].inputs.denoise,0.65);
    return Response.json({prompt_id:'mock-flux'});
  }
  return mock(url,init);
};
await runFluxSchnell({...input,denoise:0.65},{fetch:imageMock,sourceImage:new Blob(['mock original'],{type:'image/png'})});
assert.equal(uploads,1); assert.equal(imageSubmits,1);
await assert.rejects(runFluxSchnell(input,{sourceImage:new Blob(['mock']),fetch:async (url,init)=>url.endsWith('/queue')?Response.json({queue_running:[['busy']]}):imageMock(url,init)}),/还有任务/);
assert.equal(uploads,1);
console.log('Image-to-image upload, encoded latent, resize, denoise and busy-queue guard passed with mocks. No real render.');
