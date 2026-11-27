import {bounded,idbDeadline,fetchBody,armIdbRead} from './operation-scope.ts';
import { mediaUrlRegistry } from "./object-url-registry.ts";
import { withProjectMediaWrite } from "./project-media-lock.ts";
import { openLocalDatabase } from "./local-database-open.ts";

const DATABASE_NAME = "frameflow-local-media";
const DATABASE_VERSION = 2;
const VIDEO_STORE = "videos";
const IMAGE_STORE = "images";
const AUDIO_STORE = "audios";
const AUDIO_DATABASE_NAME = "frameflow-local-audio";
const MEDIA_PREFIX = "media:";
const IMAGE_PREFIX = "image:";
const AUDIO_PREFIX = "audio:";

type StoredVideo = {
  id: string;
  blob: Blob;
  name: string;
  type: string;
  size: number;
  createdAt: number;
};

let databasePromise: Promise<IDBDatabase> | null = null;
let audioDatabasePromise: Promise<IDBDatabase> | null = null;

function openDatabase() {
  if (!databasePromise) {
    const pending = openLocalDatabase(DATABASE_NAME, DATABASE_VERSION, (request) => {
        const database = request.result;
        if (!database.objectStoreNames.contains(VIDEO_STORE)) {
          database.createObjectStore(VIDEO_STORE, { keyPath: "id" });
        }
        if (!database.objectStoreNames.contains(IMAGE_STORE)) database.createObjectStore(IMAGE_STORE, { keyPath: "id" });
    }, () => { if (databasePromise === pending) databasePromise = null; }, "无法打开本地视频存储");
    databasePromise = pending;
  }
  return databasePromise;
}

function openAudioDatabase() {
  if (!audioDatabasePromise) {
    const pending = openLocalDatabase(AUDIO_DATABASE_NAME, 1, (request) => request.result.createObjectStore(AUDIO_STORE, { keyPath: "id" }), () => { if (audioDatabasePromise === pending) audioDatabasePromise = null; }, "无法打开本地声音存储");
    audioDatabasePromise = pending;
  }
  return audioDatabasePromise;
}

function waitForTransaction(transaction: IDBTransaction,signal?:AbortSignal) {
  return idbDeadline<void>(transaction,(resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error("本地视频存储失败"));
    transaction.onabort = () => reject(transaction.error ?? new Error("本地视频存储已中止"));
  },15000,signal);
}

export function isPersistedVideoSource(source: string) {
  return source.startsWith(MEDIA_PREFIX);
}

export async function storeLocalVideo(blob: Blob, name: string,signal?:AbortSignal) {
  return withProjectMediaWrite(async () => {
  const id = crypto.randomUUID();
  const record: StoredVideo = {
    id,
    blob: blob.slice(0, blob.size, blob.type || "video/mp4"),
    name,
    type: blob.type || "video/mp4",
    size: blob.size,
    createdAt: Date.now(),
  };
  const database = await openDatabase();
  signal?.throwIfAborted();
  const transaction = database.transaction(VIDEO_STORE, "readwrite");
  transaction.objectStore(VIDEO_STORE).put(record);
  await waitForTransaction(transaction,signal);
  signal?.throwIfAborted();
  return `${MEDIA_PREFIX}${id}`;
  });
}

export async function storeLocalImage(blob: Blob, name: string, signal?:AbortSignal) {
  signal?.throwIfAborted();
  // Materialize the bytes before IDB. Do not retain a lazy fetch/temporary-file Blob.
  const materialized=new Blob([await blob.arrayBuffer()],{type:blob.type});signal?.throwIfAborted();
  return withProjectMediaWrite(async () => {
  const id = crypto.randomUUID();
  const database = await openDatabase();
  signal?.throwIfAborted();
  const transaction = database.transaction(IMAGE_STORE, "readwrite");
  transaction.objectStore(IMAGE_STORE).put({ id, blob:materialized, name, createdAt: Date.now() });
  await idbDeadline<void>(transaction,(resolve,reject)=>{transaction.oncomplete=()=>resolve();transaction.onerror=transaction.onabort=()=>reject(transaction.error??Error('图片保存失败'));},15000,signal);
  signal?.throwIfAborted();
  return `${IMAGE_PREFIX}${id}`;
  });
}

export async function storeLocalAudio(blob: Blob, name: string) {
  return withProjectMediaWrite(async () => {
  const id = crypto.randomUUID();
  const database = await openAudioDatabase();
  const transaction = database.transaction(AUDIO_STORE, "readwrite");
  transaction.objectStore(AUDIO_STORE).put({ id, blob, name, createdAt: Date.now() });
  await waitForTransaction(transaction);
  return `${AUDIO_PREFIX}${id}`;
  });
}

export async function getLocalAudioBlob(source: string): Promise<Blob> {
  // Early role uploads stored audio Blobs in the video store; keep those references usable.
  if (isPersistedVideoSource(source)) return getLocalVideoBlob(source);
  if (!source.startsWith(AUDIO_PREFIX)) {
    const response = await fetch(source);
    if (!response.ok) throw new Error("声音文件无法读取");
    return response.blob();
  }
  const database = await openAudioDatabase();
  const record = await new Promise<{ blob: Blob } | undefined>((resolve, reject) => {
    const request = database.transaction(AUDIO_STORE, "readonly").objectStore(AUDIO_STORE).get(source.slice(AUDIO_PREFIX.length));
    armIdbRead(request,reject);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("本地声音读取失败"));
  });
  if (!record?.blob) throw new Error("本地声音已丢失，请重新导入");
  return record.blob;
}

export async function resolveAudioSource(source: string) {
  if (!source.startsWith(AUDIO_PREFIX) && !isPersistedVideoSource(source)) return source;
  // Shared, page-lifetime URL (unchanged semantics); concurrent callers now share one URL.
  return mediaUrlRegistry.pin(source, () => getLocalAudioBlob(source));
}

export async function resolveImageSource(source: string) {
  if (!source.startsWith(IMAGE_PREFIX)) return source;
  return mediaUrlRegistry.pin(source, () => getLocalImageBlob(source));
}

export async function getLocalImageBlob(source: string): Promise<Blob> {
  if (!source.startsWith(IMAGE_PREFIX)) {
    return fetchBody(source,{},r=>r.blob(),15000);
  }
  const database = await openDatabase();
  const record = await new Promise<{ blob: Blob } | undefined>((resolve, reject) => {
    const request = database.transaction(IMAGE_STORE, "readonly").objectStore(IMAGE_STORE).get(source.slice(IMAGE_PREFIX.length));
    armIdbRead(request,reject);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("本地图片读取失败"));
  });
  if (!record?.blob) throw new Error("本地图片已丢失，请重新导入");
  return record.blob;
}

async function getStoredVideo(id: string) {
  const database = await openDatabase();
  return new Promise<StoredVideo | undefined>((resolve, reject) => {
    const request = database.transaction(VIDEO_STORE, "readonly").objectStore(VIDEO_STORE).get(id);
    armIdbRead(request,reject);
    request.onsuccess = () => resolve(request.result as StoredVideo | undefined);
    request.onerror = () => reject(request.error ?? new Error("无法读取本地视频"));
  });
}

export async function getLocalVideoBlob(source: string): Promise<Blob> {
  if (isPersistedVideoSource(source)) {
    const record = await getStoredVideo(source.slice(MEDIA_PREFIX.length));
    if (!record?.blob) throw new Error("本地视频数据不存在");
    return record.blob;
  }
  return fetchBody(source,{},r=>r.blob(),15000);
}

export async function resolveVideoSource(source: string) {
  if (!source) return { url: "", revoke: false };
  if (!isPersistedVideoSource(source)) {
    if (!source.startsWith("data:")) return { url: source, revoke: false };
    const blob = await (await fetch(source)).blob();
    return { url: URL.createObjectURL(blob), revoke: true };
  }

  return { url: await mediaUrlRegistry.pin(source, () => getLocalVideoBlob(source)), revoke: false };
}

/**
 * Phase 9: reference-counted media URL for canvas nodes. Every acquire must be paired with one
 * releaseMediaUrl(source). Non-persisted sources (plain URLs) are returned as-is; data: sources are
 * the caller's own temporary (revoke: true), as with resolveVideoSource.
 */
export async function acquireMediaUrl(source: string): Promise<{ url: string; key: string | null; revoke: boolean }> {
  if (source.startsWith(IMAGE_PREFIX)) return { url: await mediaUrlRegistry.acquire(source, () => getLocalImageBlob(source)), key: source, revoke: false };
  if (source.startsWith(AUDIO_PREFIX)) return { url: await mediaUrlRegistry.acquire(source, () => getLocalAudioBlob(source)), key: source, revoke: false };
  if (isPersistedVideoSource(source)) return { url: await mediaUrlRegistry.acquire(source, () => getLocalVideoBlob(source)), key: source, revoke: false };
  const resolved = await resolveVideoSource(source);
  return { ...resolved, key: null };
}
export function releaseMediaUrl(key: string | null) { if (key) mediaUrlRegistry.release(key); }

/** Only after Windows recycling succeeded; caller holds the exclusive project lock. */
export async function removeRecycledMediaBytes(source: string) {
  const spec = source.startsWith(IMAGE_PREFIX) ? [await openDatabase(), IMAGE_STORE, source.slice(IMAGE_PREFIX.length)] as const
    : source.startsWith(MEDIA_PREFIX) ? [await openDatabase(), VIDEO_STORE, source.slice(MEDIA_PREFIX.length)] as const
    : source.startsWith(AUDIO_PREFIX) ? [await openAudioDatabase(), AUDIO_STORE, source.slice(AUDIO_PREFIX.length)] as const : null;
  if (!spec) throw Error('未知媒体存储方式，未清理浏览器副本');
  const tx = spec[0].transaction(spec[1], 'readwrite');
  tx.objectStore(spec[1]).delete(spec[2]);
  await waitForTransaction(tx);
}

export async function migrateVideoDataUrl(source: string, name: string) {
  if (!source.startsWith("data:")) return source;
  const blob = await (await fetch(source)).blob();
  return storeLocalVideo(blob, name);
}

export async function readVideoMetadata(blob: Blob) {
  const url = URL.createObjectURL(blob);
  try {
    return await new Promise<{ duration: string; width: number; height: number }>((resolve, reject) => {
      const video = document.createElement("video");
      // A video element that never fires loadedmetadata used to hold the run-output lock forever.
      const timer = setTimeout(() => { video.onloadedmetadata = null; video.onerror = null; video.removeAttribute("src"); video.load(); reject(new Error("视频元数据超时")); }, 8000);
      video.preload = "metadata";
      video.onloadedmetadata = () => {
        clearTimeout(timer);
        resolve({
          duration: Number.isFinite(video.duration) ? `${video.duration.toFixed(1)} 秒` : "—",
          width: video.videoWidth,
          height: video.videoHeight,
        });
      };
      video.onerror = () => { clearTimeout(timer); reject(new Error("浏览器无法解析此 MP4 的编码")); };
      video.src = url;
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Phase 18: exact duration in seconds (null when the browser cannot tell). Separate from readVideoMetadata so its callers are unchanged. */
export async function readVideoDurationSeconds(blob: Blob) {
  const url = URL.createObjectURL(blob);
  try {
    return await new Promise<number | null>((resolve) => {
      const video = document.createElement("video");
      video.preload = "metadata";
      video.onloadedmetadata = () => resolve(Number.isFinite(video.duration) && video.duration > 0 ? video.duration : null);
      video.onerror = () => resolve(null);
      video.src = url;
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}

export const extractVideoLastFrame = (source: string,signal?:AbortSignal) => extractVideoEdgeFrame(source, "last",signal);
export const extractVideoFirstFrame = (source: string,signal?:AbortSignal) => extractVideoEdgeFrame(source, "first",signal);
/** PNG from decoded source pixels, never the scaled canvas preview. */
export const extractVideoFrameAt = (source: string, seconds: number,signal?:AbortSignal) => extractVideoEdgeFrame(source, seconds,signal);

async function extractVideoEdgeFrame(source: string, edge: "first" | "last" | number,signal?:AbortSignal) {
  return bounded(async scope=>{
  if (typeof edge === "number" && (!Number.isFinite(edge) || edge < 0)) throw new Error("截帧时间无效");
  const acquired = await acquireMediaUrl(source);
  if(scope.signal.aborted){releaseMediaUrl(acquired.key);if(acquired.revoke)URL.revokeObjectURL(acquired.url);scope.check();}
  const url = acquired.url;
  const video = document.createElement("video");
  const abort=()=>{video.pause();video.removeAttribute('src');video.load();};
  scope.signal.addEventListener('abort',abort,{once:true});
  try {
    video.preload = "auto";
    video.muted = true;
    video.playsInline = true;
    video.src = url;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => finish(new Error("读取视频超时，请重试")), 8000);
      const finish = (error?: Error) => { clearTimeout(timer); video.onloadedmetadata = null; video.onerror = null; if (error) reject(error); else resolve(); };
      video.onloadedmetadata = () => finish();
      video.onerror = () => finish(new Error("无法读取视频以提取画面"));
      if (video.readyState >= 1) finish();
    });
    scope.check();
    if (!Number.isFinite(video.duration) || video.duration <= 0) throw new Error("视频时长无效，无法提取首尾帧");
    const target = typeof edge === "number" ? Math.min(edge, Math.max(0,video.duration-0.001)) : edge === "first" ? 0 : Math.max(0, video.duration - Math.min(0.08, video.duration / 10));
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => finish(new Error("视频画面定位超时，请重试")), 8000);
      const finish = (error?: Error) => { clearTimeout(timer); video.onseeked = null; video.onloadeddata = null; video.onerror = null; if (error) reject(error); else resolve(); };
      if (target === video.currentTime && video.readyState >= 2) { finish(); return; }
      if (target === 0) video.onloadeddata = () => finish();
      video.onseeked = () => finish();
      video.onerror = () => finish(new Error("视频画面定位失败"));
      video.currentTime = target;
    });
    scope.check();
    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const context = canvas.getContext("2d");
    if (!context || !canvas.width || !canvas.height) throw new Error("视频没有可提取的有效画面");
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((value) => value ? resolve(value) : reject(new Error("视频画面编码失败")), typeof edge === "number" ? "image/png" : "image/jpeg", 0.92));
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(new Error("视频画面读取失败"));
      reader.readAsDataURL(blob);
    });
    scope.check();
    return { dataUrl, width: canvas.width, height: canvas.height, seconds: video.currentTime };
  } finally {
    video.pause(); video.removeAttribute("src"); video.load();
    releaseMediaUrl(acquired.key);
    if (acquired.revoke && url) URL.revokeObjectURL(url);
    scope.signal.removeEventListener('abort',abort);
  }
  },20000,signal,'截取视频画面');
}
