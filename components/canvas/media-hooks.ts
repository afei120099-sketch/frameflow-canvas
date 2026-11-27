"use client";
// Stage I: extracted from canvas-workspace.tsx without behaviour change.
import { useEffect, useState, useSyncExternalStore } from "react";
import { getCanvasInteracting, subscribeCanvasInteraction } from '@/lib/canvas-interaction';
import { useValue, type Editor, type TLShape } from "tldraw";
import { acquireMediaUrl, releaseMediaUrl } from "@/lib/local-video-store";
import { FAR_ZOOM, isNearViewport, shouldActivateMedia } from "@/lib/media-activation";
import { getPoster, loadPoster, subscribePoster } from "@/lib/poster-cache";
import { VideoPlayerBudget } from "@/lib/video-player-budget";
const videoBudget = new VideoPlayerBudget(2);
const noInteractionSubscription=()=>()=>{};

export function useVideoPoster(source: string) {
  const [poster,setPoster] = useState<{source:string;url:string}>({source:"",url:""});
  const [ready,setReady] = useState("");
  useEffect(()=>{
    let alive=true;
    const refresh=()=>{ if(alive) setPoster({source,url:getPoster(source) ?? ""}); };
    const off=subscribePoster(source,refresh);
    void loadPoster(source).then(()=>{ if(alive) { refresh(); setReady(source); } });
    return ()=>{alive=false;off();};
  },[source]);
  return { poster:poster.source===source?poster.url:getPoster(source), ready:ready===source };
}
export function useVideoActive(eligible:boolean, selected:boolean, playing:boolean, source:string) {
  const watchInteraction=eligible&&!playing;
  const interacting=useSyncExternalStore(watchInteraction?subscribeCanvasInteraction:noInteractionSubscription,()=>watchInteraction&&getCanvasInteracting(),()=>false);
  const eligibleNow=eligible&&!interacting;
  const [active,setActive]=useState(false);
  useEffect(()=>{
    let alive=true;
    if(!eligibleNow && !playing) { queueMicrotask(()=>{if(alive)setActive(false);}); return ()=>{alive=false;}; }
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const priority=playing?100:selected?10:1;
    const release=videoBudget.request({},priority,value=>{
      if(alive)setActive(value);
      clearTimeout(timeout);
      // A corrupt/black video must not monopolize a background poster slot forever.
      // Clicking it requests a selected player and is not subject to this timeout.
      if(value && priority===1) timeout=setTimeout(()=>{release();if(alive)setActive(false);},15_000);
    });
    return ()=>{alive=false;clearTimeout(timeout);release();};
  },[eligibleNow,selected,playing,source]);
  return (eligibleNow||playing) && active;
}

/** Phase 9: true while the node is near the viewport and not at the far LOD (or playing / kept alive). */
export function useMediaActive(editor: Editor, shapeId: TLShape["id"], extra: { playing?: boolean; keepAlive?: boolean } = {}) {
  const near = useValue("frameflow media near viewport", () => isNearViewport(editor.getShapePageBounds(shapeId), editor.getViewportPageBounds()) && editor.getZoomLevel() >= FAR_ZOOM, [editor, shapeId]);
  return shouldActivateMedia({ near, zoom: near ? FAR_ZOOM : 0, playing: extra.playing, keepAlive: extra.keepAlive });
}
/** Phase 9: shared, reference-counted media URL while active; released (and later revoked) when inactive or unmounted. */
export function useAcquiredMediaUrl(source: string, active: boolean) {
  const [url, setUrl] = useState({ source: "", value: "" });
  useEffect(() => {
    if (!active || !source) { queueMicrotask(() => setUrl({source,value:""})); return; }
    let alive = true; let key: string | null = null; let owned = "";
    void acquireMediaUrl(source).then((result) => {
      if (!alive) { releaseMediaUrl(result.key); if (result.revoke) URL.revokeObjectURL(result.url); return; }
      key = result.key; if (result.revoke) owned = result.url; setUrl({source,value:result.url});
    }).catch(() => { if (alive) setUrl({source,value:""}); });
    return () => { alive = false; releaseMediaUrl(key); if (owned) URL.revokeObjectURL(owned); };
  }, [source, active]);
  return active && url.source === source ? url.value : "";
}
