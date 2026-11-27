/**
 * Small reconstructible poster cache. Original video databases remain untouched.
 * The first time a video node's player has a frame, a small JPEG data URL is kept per media source,
 * so the node can show a still instead of a live player when it is off-screen or re-mounted.
 */

const MAX_POSTERS = 600;
const POSTER_WIDTH = 320;
const posters = new Map<string, string>();
const loading = new Map<string, Promise<string | undefined>>();
const listeners = new Map<string, Set<() => void>>();
let database: Promise<IDBDatabase> | undefined;
let warned = false;
function warnPosterStorage() {
  if (!warned && typeof window !== "undefined") { warned = true; window.dispatchEvent(new CustomEvent("canvas-toast", { detail: "首帧封面缓存读写失败；原视频不受影响，重开可能需要重新加载封面" })); }
}
const stableSource = (source: string) => source.startsWith("media:") || /^https?:/.test(source);
function openPosters() {
  if (!database) database = new Promise<IDBDatabase>((resolve,reject) => {
    let blocked=false;
    const request = indexedDB.open("frameflow-video-posters",1);
    request.onupgradeneeded = () => request.result.createObjectStore("posters", {keyPath:"source"});
    request.onsuccess = () => { const db=request.result; if(blocked){db.close();return;} db.onversionchange=()=>{db.close();database=undefined;}; resolve(db); };
    request.onerror = () => { database=undefined; reject(request.error); };
    request.onblocked = () => { blocked=true; database=undefined; reject(new Error("封面缓存被占用")); };
  });
  return database;
}
function publish(source: string) { listeners.get(source)?.forEach(listener=>listener()); }
export function subscribePoster(source: string, listener: () => void) {
  const set=listeners.get(source) ?? new Set<() => void>(); set.add(listener); listeners.set(source,set);
  return () => { set.delete(listener); if(!set.size) listeners.delete(source); };
}
export async function loadPoster(source: string): Promise<string | undefined> {
  if(posters.has(source)) return posters.get(source);
  if(!stableSource(source) || typeof indexedDB === "undefined") return;
  if(loading.has(source)) return loading.get(source);
  const work=(async()=>{
    try {
      const db=await openPosters();
      const data=await new Promise<string | undefined>((resolve,reject)=>{
        const tx=db.transaction("posters","readonly"); let data: string | undefined;
        const request=tx.objectStore("posters").get(source);
        request.onsuccess=()=>{ data=request.result?.dataUrl; };
        tx.oncomplete=()=>resolve(data); tx.onerror=tx.onabort=()=>reject(tx.error);
      });
      // A newer live capture always wins over a slow cache read.
      if(data && !posters.has(source)) { cachePoster(source,data); publish(source); }
      return posters.get(source);
    } catch { warnPosterStorage(); return undefined; }
    finally { loading.delete(source); }
  })();
  loading.set(source,work); return work;
}
function cachePoster(source:string,dataUrl:string) {
  posters.delete(source); posters.set(source,dataUrl);
  while(posters.size>MAX_POSTERS) posters.delete(posters.keys().next().value as string);
}

export const getPoster = (source: string) => posters.get(source);
export const posterCount = () => posters.size;

export function rememberPoster(source: string, dataUrl: string) {
  if (!source || !dataUrl) return;
  cachePoster(source,dataUrl); publish(source);
  if(stableSource(source) && typeof indexedDB !== "undefined") void (async()=>{
    const db=await openPosters();
    await new Promise<void>((resolve,reject)=>{
      const tx=db.transaction("posters","readwrite");
      tx.objectStore("posters").put({source,dataUrl,createdAt:Date.now()});
      tx.oncomplete=()=>resolve(); tx.onerror=tx.onabort=()=>reject(tx.error);
    });
  })().catch(warnPosterStorage);
}

/** Decode the first displayed frame without starting playback or touching a playing video. */
export function preparePosterFrame(video: HTMLVideoElement) {
  if (!video.paused || video.currentTime !== 0 || !Number.isFinite(video.duration) || video.duration <= 0) return;
  // A tiny seek makes Chromium paint the opening frame instead of its empty t=0 surface.
  video.currentTime = Math.min(0.001, video.duration / 2);
}

export function hasVisiblePosterPixels(pixels: Uint8ClampedArray) {
  for (let i = 0; i < pixels.length; i += 4) {
    if (pixels[i] > 8 || pixels[i + 1] > 8 || pixels[i + 2] > 8) return true;
  }
  return false;
}

/** Draws a decoded opening frame once; never caches an empty black decode surface. */
export function capturePoster(source: string, video: HTMLVideoElement) {
  if (posters.has(source)) return posters.get(source);
  if (!source || video.readyState < 2 || video.seeking || !video.videoWidth || !video.videoHeight) return;
  try {
    const canvas = document.createElement("canvas");
    canvas.width = POSTER_WIDTH;
    canvas.height = Math.max(1, Math.round(POSTER_WIDTH * video.videoHeight / video.videoWidth));
    const context = canvas.getContext("2d");
    if (!context) return;
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    if (!hasVisiblePosterPixels(context.getImageData(0, 0, canvas.width, canvas.height).data)) return;
    const poster = canvas.toDataURL("image/jpeg", 0.72);
    rememberPoster(source, poster);
    return poster;
  } catch { /* poster is best effort */ }
}
