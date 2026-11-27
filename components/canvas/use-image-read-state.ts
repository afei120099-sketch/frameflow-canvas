"use client";
import { useEffect, useState } from "react";
import { acquireMediaUrl, releaseMediaUrl } from "@/lib/local-video-store";
import { logEvent } from "@/lib/error-log";

export function useImageReadState(source: string, nodeId?: string) {
  const [state, setState] = useState({ source, url: source.startsWith("image:") ? "" : source, error: "" });
  const fail = (message: string) => {
    setState({ source, url: "", error: message });
    void logEvent({ level: "error", category: "asset", title: "图片无法读取", detail: message, nodeId }).catch(() => {});
  };
  useEffect(() => {
    let active = true;
    let releaseKey: string | null = null;
    const failRead = (cause: unknown) => {
      if (!active) return;
      const message = cause instanceof Error ? cause.message : "本地图片无法读取";
      setState({ source, url: "", error: message });
      void logEvent({ level: "error", category: "asset", title: "图片无法读取", detail: message, nodeId }).catch(() => {});
    };
    // image: used to pin() for the whole tab. Count a reference instead and release it on unmount
    // or when the node leaves the viewport, so the Blob can be revoked.
    if (source.startsWith("image:")) {
      void acquireMediaUrl(source).then(result => {
        if (!active) { releaseMediaUrl(result.key); return; }
        releaseKey = result.key;
        setState({ source, url: result.url, error: "" });
      }).catch(failRead);
      return () => { active = false; releaseMediaUrl(releaseKey); releaseKey = null; };
    }
    let ownedUrl = "";
    void acquireMediaUrl(source).then(result => {
      if (!active) { releaseMediaUrl(result.key); if (result.revoke) URL.revokeObjectURL(result.url); return; }
      releaseKey = result.key;
      if (result.revoke) ownedUrl = result.url;
      setState({ source, url: result.url, error: "" });
    }).catch(failRead);
    return () => { active = false; releaseMediaUrl(releaseKey); releaseKey = null; if (ownedUrl) URL.revokeObjectURL(ownedUrl); };
  }, [source, nodeId]);
  return { ...(state.source === source ? state : { source, url: source.startsWith("image:") ? "" : source, error: "" }), fail };
}
