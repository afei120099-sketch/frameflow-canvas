"use client";

import { useEffect, useState } from "react";
import { getSnapshot, loadSnapshot, type Editor } from "tldraw";
import { loadFrameflowInstance, mediaKeysIn, type FrameflowInstanceInfo } from "@/lib/frameflow-instance";
import { mediaUrlRegistry } from "@/lib/object-url-registry";
import { collectProject, mergePagePack, readBackup, type BackupSource } from "@/lib/project-backup";

async function remoteSource(transfer: string, scope: string): Promise<BackupSource | null> {
  const list = await fetch(`${transfer}/list?scope=${encodeURIComponent(scope)}`, { cache: "no-store" }).then((response) => response.ok ? response.json() : null).catch(() => null);
  const files = ((list as { files?: unknown } | null)?.files ?? []) as { name: string; size: number }[];
  if (!files.some((file) => file.name === "manifest.json")) return null;
  const sizes = new Map(files.map((file) => [file.name, file.size]));
  const read = async (file: string) => {
    const response = await fetch(`${transfer}/file?scope=${encodeURIComponent(scope)}&file=${encodeURIComponent(file)}`, { cache: "no-store" });
    if (!response.ok) throw new Error(`缺少 ${file}`);
    return response;
  };
  return { has: (file) => sizes.has(file), size: (file) => sizes.get(file) ?? null, readText: async (file) => (await read(file)).text(), readBlob: async (file) => (await read(file)).blob() };
}

export function InstanceChrome({ editor }: { editor: Editor | null }) {
  const [info, setInfo] = useState<FrameflowInstanceInfo | null>(null);
  const [note, setNote] = useState("");
  useEffect(() => {
    let alive = true;
    void loadFrameflowInstance().then((next) => { if (!alive) return; setInfo(next); if (next.name) document.title = `${next.name} · Frameflow`; });
    return () => { alive = false; };
  }, []);
  useEffect(() => {
    if (!editor) return;
    const release = () => mediaUrlRegistry.releaseUnreferenced(mediaKeysIn(editor.getCurrentPageShapes().map((shape) => shape.props)));
    release();
    let pageId = editor.getCurrentPageId();
    const stop = editor.store.listen(() => {
      const next = editor.getCurrentPageId();
      if (next === pageId) return;
      pageId = next;
      release();
    });
    return () => { stop(); release(); };
  }, [editor]);
  useEffect(() => {
    if (!editor) return;
    let cancelled = false;
    void (async () => {
      const instance = await loadFrameflowInstance();
      if (cancelled || !instance.id) return;
      const marker = `frameflow-page-pack:${instance.id}`;
      if (localStorage.getItem(marker) === "done") { setNote("工程包已在这个画布"); return; }
      try {
        const source = await remoteSource(instance.transfer, instance.id);
        if (cancelled || !source) { setNote("还没有这个画布的工程包"); return; }
        const parsed = await readBackup(source);
        if (cancelled) return;
        const counts = source.has("_counts.json") ? JSON.parse(await source.readText("_counts.json")) as { shapes?: number; assets?: number; images?: number; videos?: number; audios?: number; roles?: number; pageName?: string } : null;
        await mergePagePack(parsed, { current: () => getSnapshot(editor.store).document, load: (document) => loadSnapshot(editor.store, { document: document as ReturnType<typeof getSnapshot>["document"] }) });
        if (cancelled) return;
        const after = await collectProject();
        const shapes = editor.store.allRecords().filter((record) => record.typeName === "shape").length;
        const actual = { shapes, assets: after.records.assets.length, images: after.media.images.length, videos: after.media.videos.length, audios: after.media.audios.length, roles: after.records.roles.length };
        const pages = editor.getPages().map((page) => ({ id: page.id, name: page.name, shapes: editor.getPageShapeIds(page.id).size }));
        const same = counts ? (["shapes", "assets", "images", "videos", "audios", "roles"] as const).every((key) => counts[key] == null || counts[key] === actual[key]) : null;
        const text = `${counts?.pageName || instance.name}：节点 ${actual.shapes}${counts?.shapes != null ? ` / 原页 ${counts.shapes}` : ""}，素材 ${actual.assets}${counts?.assets != null ? ` / 原页 ${counts.assets}` : ""}${same === false ? "，数量不一致" : ""}`;
        localStorage.setItem(marker, "done");
        setNote(text);
        await fetch(`${instance.transfer}/report?scope=${encodeURIComponent(instance.id)}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ at: new Date().toISOString(), instance: instance.id, ...actual, pages, expected: counts, same, text }) }).catch(() => undefined);
      } catch (error) { if (!cancelled) setNote(error instanceof Error ? error.message : "导入失败"); }
    })();
    return () => { cancelled = true; };
  }, [editor]);
  if (!info) return null;
  // Only named instances show a badge; the import note stays in its tooltip.
  return info.name ? <span className="version-pill" title={note || info.id}>{info.name}</span> : null;
}
