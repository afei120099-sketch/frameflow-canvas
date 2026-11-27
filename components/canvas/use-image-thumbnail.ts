"use client";

import { useEffect, useState } from "react";
import { logEvent } from "@/lib/error-log";
import { thumbnailBlob } from "@/lib/image-thumbnail";
import { mediaUrlRegistry } from "@/lib/object-url-registry";

/**
 * Shared, reference-counted thumbnail for a node <img>. Released on unmount or when the
 * source leaves the viewport. This does not pin() the original blob.
 */
export function useImageThumbnail(source: string, maxEdge = 512, nodeId?: string) {
  const [state, setState] = useState({ source: "", url: "", error: "" });
  const fail = (message: string) => {
    setState({ source, url: "", error: message });
    void logEvent({ level: "error", category: "asset", title: "图片无法读取", detail: message, nodeId }).catch(() => {});
  };
  useEffect(() => {
    if (!source) return;
    let alive = true;
    const key = `thumb:${maxEdge}:${source}`;
    void mediaUrlRegistry.acquire(key, () => thumbnailBlob(source, maxEdge)).then((url) => {
      if (!alive) return;
      setState({ source, url, error: "" });
    }).catch((cause: unknown) => {
      if (!alive) return;
      const message = cause instanceof Error ? cause.message : "本地图片无法读取";
      setState({ source, url: "", error: message });
      void logEvent({ level: "error", category: "asset", title: "图片无法读取", detail: message, nodeId }).catch(() => {});
    });
    return () => { alive = false; mediaUrlRegistry.release(key); };
  }, [source, maxEdge, nodeId]);
  if (!source || state.source !== source) return { url: "", error: "", fail };
  return { ...state, fail };
}
