import assert from 'node:assert/strict';
import { buildFluxDev, runFluxDev, FLUX_DEV_MODELS } from '../lib/comfyui/flux-dev.ts';

const input = { prompt: 'Natural auburn hair, preserve face and scene', width: 768, height: 1024, seed: 42 };
const text = buildFluxDev(input);
assert.equal(text['1'].class_type, 'UNETLoader');
assert.equal(text['1'].inputs.unet_name, FLUX_DEV_MODELS.unet);
assert.equal(text['10'].inputs.device, 'cpu');
assert.equal(text['12'].inputs.guidance, 3.5);
assert.equal(text['5'].inputs.steps, 24);
assert.equal(text['5'].inputs.cfg, 1);
assert.equal(text['5'].inputs.denoise, 1);
assert.deepEqual(text['5'].inputs.model, ['1', 0]);
const image = buildFluxDev({ ...input, imageName: 'original.png', denoise: .45 });
assert.equal(image['3'].class_type, 'VAEEncode');
assert.equal(image['5'].inputs.denoise, .45);
assert.deepEqual(image['7'].inputs.images, ['6', 0]);
const mask = buildFluxDev({ ...input, imageName: 'original.png', maskName: 'mask.png', denoise: .6, extraLora: true });
assert.equal(mask['16'].inputs.channel, 'red', 'Opaque editor PNG is a luminance mask, not LoadImage alpha');
assert.deepEqual(mask['5'].inputs.latent_image, ['24', 0]);
assert.deepEqual(mask['25'].inputs.destination, ['9', 0]);
assert.deepEqual(mask['25'].inputs.mask, ['23', 0]);
assert.deepEqual(mask['7'].inputs.images, ['25', 0]);
assert.equal(mask['22'].class_type, 'ImageBlur');
assert.equal(mask['26'], undefined, 'No extra LoRA loader');
assert.deepEqual(mask['5'].inputs.model, ['1', 0]);
assert.equal(mask['5'].inputs.denoise, .6);
const defaultMask = buildFluxDev({ ...input, imageName: 'original.png', maskName: 'mask.png' });
assert.equal(defaultMask['26'], undefined, 'Inpainting adds no LoRA');
assert.deepEqual(defaultMask['5'].inputs.model, ['1', 0]);
const noLora = buildFluxDev({ ...input, imageName: 'original.png', maskName: 'mask.png', extraLora: false });
assert.equal(noLora['26'], undefined, 'Legacy extraLora flag is ignored');
assert.deepEqual(noLora['5'].inputs.model, ['1', 0]);
assert.equal(buildFluxDev({ ...input, imageName: 'original.png', maskName: 'mask.png' })['5'].inputs.denoise, .5);
for (const graph of [text, image, mask]) {
  assert.equal(Object.values(graph).filter(n=>n.class_type==='LoraLoaderModelOnly').length,0);
  for (const node of Object.values(graph)) for (const value of Object.values(node.inputs)) if (Array.isArray(value)) assert.ok(graph[value[0]], `Broken dependency ${value}`);
  assert.ok(!Object.values(graph).some(n => n.class_type === 'CheckpointLoaderSimple'));
}
assert.throws(() => buildFluxDev({ ...input, maskName: 'mask.png' }), /原图/);
assert.throws(() => buildFluxDev({ ...input, denoise: 0 }), /强度/);
assert.throws(() => buildFluxDev({ ...input, guidance: NaN }), /引导/);
assert.throws(() => buildFluxDev({ ...input, maskBlur: 50 }), /遮罩/);

let uploads = 0, submits = 0;
const request = async (url, options) => {
  if (url.includes('/object_info/')) {
    const node = url.split('/').pop();
    const required = node === 'UNETLoader' ? { unet_name: [[FLUX_DEV_MODELS.unet]] }
      : node === 'DualCLIPLoader' ? { clip_name1: [[FLUX_DEV_MODELS.clip]], clip_name2: [[FLUX_DEV_MODELS.t5]] }
      : node === 'VAELoader' ? { vae_name: [[FLUX_DEV_MODELS.vae]] } : {};
    return Response.json({ [node]: { input: { required } } });
  }
  if (url.endsWith('/queue')) return Response.json({ queue_running: [], queue_pending: [] });
  if (url.endsWith('/upload/image')) {
    assert.equal(options.body.get('overwrite'), 'false');
    uploads++;
    return Response.json({ name: uploads % 2 ? 'original.png' : 'mask.png', subfolder: 'test' });
  }
  if (url.endsWith('/prompt')) {
    submits++;
    const graph = JSON.parse(options.body).prompt;
    assert.equal(graph['8'].inputs.image, 'test/original.png');
    assert.equal(graph['15'].inputs.image, 'test/mask.png');
    assert.equal(graph['5'].inputs.cfg, 1);
    assert.deepEqual(graph['5'].inputs.model, ['1', 0]);
    assert.equal(graph['26'], undefined);
    return Response.json({ prompt_id: 'dev-test' });
  }
  if (url.includes('/history/')) return Response.json({ 'dev-test': { status: { completed: true }, outputs: { '7': { images: [{ filename: 'edited.png', type: 'output' }] } } } });
  if (url.includes('/view?')) return new Response(new Blob(['result'], { type: 'image/png' }));
  throw new Error(url);
};
const options = { fetch: request, sourceImage: new Blob(['original'], { type: 'image/png' }), maskImage: new Blob(['mask'], { type: 'image/png' }), pollMs: 0 };
const result = await runFluxDev({ ...input, imageName: 'pending.png', maskName: 'pending-mask.png' }, options);
assert.equal(result.filename, 'edited.png'); assert.equal(uploads, 2); assert.equal(submits, 1);
await assert.rejects(runFluxDev(input, { ...options, fetch: async (url, init) => url.endsWith('/queue') ? Response.json({ queue_running: [['busy']] }) : request(url, init) }), /还有任务/);
assert.equal(uploads, 2); assert.equal(submits, 1);
await assert.rejects(runFluxDev(input, { ...options, fetch: async (url, init) => url.includes('/object_info/UNETLoader') ? Response.json({ UNETLoader: { input: { required: { unet_name: [[]] } } } }) : request(url, init) }), /未识别模型/);
assert.equal(uploads, 2); assert.equal(submits, 1);
console.log('Dev graph, explicit FluxGuidance/CFG, img2img, mask/composite, two uploads, model and queue guards PASS. No GPU task submitted.');
