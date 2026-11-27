export type RemovalTaskState = 'queued' | 'running' | 'completed' | 'failed' | 'not_found' | 'uncertain';
type Json = Record<string, unknown>;
const object = (value: unknown): value is Json => !!value && typeof value === 'object' && !Array.isArray(value);
async function read(path: string, request: typeof fetch) {
  const response = await request(path, { cache: 'no-store', signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw Error(`任务状态查询失败（HTTP ${response.status}）`);
  const value: unknown = await response.json();
  if (!object(value)) throw Error('任务状态格式异常，未删除');
  return value;
}
/** GET-only deletion probe. Deliberately independent of the video-only H3 probe. */
export async function probeRemovalTask(id: string, kind: 'image' | 'audio' | 'video', saveId?: string, request: typeof fetch = fetch): Promise<RemovalTaskState> {
  const history = async (): Promise<RemovalTaskState | null> => {
    const data = await read('/comfyui/history/' + encodeURIComponent(id), request);
    if (!(id in data)) return null;
    const entry = data[id]; if (!object(entry)) return 'uncertain';
    const outputs = object(entry.outputs) ? entry.outputs : {};
    const items = saveId ? [outputs[saveId]] : Object.values(outputs);
    const keys = kind === 'audio' ? ['audio'] : kind === 'image' ? ['images'] : ['videos', 'gifs', 'images'];
    const files = items.flatMap(item => object(item) ? keys.flatMap(key => Array.isArray(item[key]) ? item[key] : []) : []);
    // A partial output is still a result to recover, even if another node failed later.
    if (files.some(file => object(file) && typeof file.filename === 'string' && (kind !== 'video' || /\.mp4$/i.test(file.filename)))) return 'completed';
    const status = object(entry.status) ? entry.status : {};
    if (status.status_str === 'error' || Array.isArray(status.messages) && status.messages.some(message => Array.isArray(message) && ['execution_error', 'execution_interrupted'].includes(message[0]))) return 'failed';
    return 'uncertain'; // Success without the expected output is not proof of safe deletion.
  };
  const first = await history(); if (first) return first;
  const queue = await read('/comfyui/queue', request);
  const valid = (value: unknown): value is unknown[][] => Array.isArray(value) && value.every(row => Array.isArray(row) && typeof row[1] === 'string');
  if (!valid(queue.queue_running) || !valid(queue.queue_pending)) throw Error('后台队列格式异常，未删除');
  if (queue.queue_running.some(row => row[1] === id)) return 'running';
  if (queue.queue_pending.some(row => row[1] === id)) return 'queued';
  return (await history()) ?? 'not_found';
}
export async function probeVoiceDesignRemoval(id: string, request: typeof fetch = fetch): Promise<RemovalTaskState> {
  const data = await read('/__voice_design?id=' + encodeURIComponent(id), request);
  return ['queued', 'running', 'completed', 'failed'].includes(String(data.status)) ? data.status as RemovalTaskState : 'uncertain';
}
