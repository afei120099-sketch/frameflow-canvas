"use client";

import { useState } from "react";
import { exportPageProject, exportProjectStreaming, summarizeCanvasPages, type BackupSink } from "@/lib/project-backup";
import { instanceForPageName, pageStaysOnDefault } from "@/lib/frameflow-instance";

const TRANSFER = "http://127.0.0.1:5198";
const PERSISTENCE_KEY = "frameflow-v0.1-canvas";

async function readCanvasDocument() {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(`TLDRAW_DOCUMENT_v2${PERSISTENCE_KEY}`);
    request.onupgradeneeded = () => request.transaction?.abort();
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("打不开画布库"));
  });
  try {
    const records = await new Promise<Array<{ id?: string }>>((resolve, reject) => {
      const request = db.transaction("records", "readonly").objectStore("records").getAll();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error("画布记录读取失败"));
    });
    const schema = await new Promise<unknown>((resolve, reject) => {
      const request = db.transaction("schema", "readonly").objectStore("schema").get("schema");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error("画布 schema 读取失败"));
    });
    const store: Record<string, unknown> = {};
    for (const record of records) if (record?.id) store[record.id] = record;
    return { schema, store };
  } finally { db.close(); }
}

function sink(scope: string): BackupSink {
  const write = async (file: string, data: Blob | string) => {
    const body = typeof data === "string" ? new Blob([data], { type: "application/json" }) : data;
    const response = await fetch(`${TRANSFER}/write?scope=${encodeURIComponent(scope)}&file=${encodeURIComponent(file)}`, { method: "POST", headers: { "x-transfer-gen": "2" }, body });
    if (!response.ok) throw new Error(`${file} 写入失败：HTTP ${response.status}`);
  };
  return { writeText: write, writeBlob: write };
}

export default function PageTransfer() {
  const [lines, setLines] = useState<string[]>(["点下面的按钮。这一页只读本机数据库，不会改 5173 里的页面。"]);
  const [busy, setBusy] = useState(false);
  const log = (line: string) => setLines((current) => [...current, line]);
  const run = async () => {
    setBusy(true);
    try {
      const health = await fetch(`${TRANSFER}/`, { cache: "no-store" }).then((response) => response.ok ? response.json() : null).catch(() => null);
      if ((health as { service?: string } | null)?.service !== "frameflow-page-transfer-v1") throw new Error("中转服务没开。先运行 scripts/page-transfer-server.mjs（端口 5198）。");
      await sink("backup").writeText("_started.json", JSON.stringify({ at: new Date().toISOString(), origin: location.origin }));
      log("正在读取页面名单…");
      const document = await readCanvasDocument();
      const pages = summarizeCanvasPages(document);
      log(pages.map((page) => `${page.name || "(未命名)"}：${page.shapes} 个节点`).join("；") || "没有页面");
      await sink("backup").writeText("_pages.json", JSON.stringify({ at: new Date().toISOString(), pages }, null, 2));
      log("正在导出完整备份（一次一个文件，原画布不删除）…");
      const full = await exportProjectStreaming(document, sink("backup"), { appVersion: "V0.5", persistenceKey: PERSISTENCE_KEY, onProgress: (done, total) => { if (done === total || done % 25 === 0) { log(`完整备份媒体 ${done}/${total}`); void sink("backup").writeText("_progress.json", JSON.stringify({ at: new Date().toISOString(), done, total })); } } });
      log(`完整备份：图片 ${full.manifest.counts.images}，视频 ${full.manifest.counts.videos}，声音 ${full.manifest.counts.audios}，素材 ${full.manifest.counts.assets}，角色 ${full.manifest.counts.roles}`);
      const summary: unknown[] = [];
      for (const page of pages) {
        if (pageStaysOnDefault(page.name)) { log(`留在 5173：${page.name}（${page.shapes} 个节点）`); summary.push({ ...page, stay: true }); continue; }
        const target = instanceForPageName(page.name);
        if (!target) { log(`没有对应的新画布，仍留在 5173：${page.name}`); summary.push({ ...page, stay: true }); continue; }
        log(`正在导出 ${page.name} → ${target.label}（${target.port}）…`);
        const packed = await exportPageProject(document, sink(target.id), { appVersion: "V0.5", persistenceKey: PERSISTENCE_KEY, pageId: page.id, project: full.project, linkMedia: async (file) => {
          const response = await fetch(`${TRANSFER}/link?scope=${encodeURIComponent(target.id)}&file=${encodeURIComponent(file)}&from=backup&fromFile=${encodeURIComponent(file)}`, { method: "POST", headers: { "x-transfer-gen": "2" } });
          if (!response.ok) throw new Error(`${file} 链接失败：HTTP ${response.status}`);
        }, onProgress: (done, total) => { if (done === total || done % 25 === 0) log(`${page.name} 媒体 ${done}/${total}`); } });
        log(`${page.name}：节点 ${packed.counts.shapes}，素材 ${packed.counts.assets}，图片 ${packed.counts.images}，视频 ${packed.counts.videos}，角色 ${packed.counts.roles}`);
        summary.push({ ...page, instance: target.id, port: target.port, counts: packed.counts });
      }
      await sink("backup").writeText("_export_done.json", JSON.stringify({ at: new Date().toISOString(), summary }, null, 2));
      log("导出完成。打开对应桌面入口后，新画布会自己导入，不会覆盖它已有的内容。");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log(message);
      await fetch(`${TRANSFER}/report?scope=backup`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ at: new Date().toISOString(), error: message }) }).catch(() => undefined);
    }
    finally { setBusy(false); }
  };
  return <main style={{ maxWidth: 760, margin: "40px auto", fontFamily: "sans-serif", lineHeight: 1.5 }}>
    <h1>导出各页到新画布</h1>
    <p>仙侠和尾帧高清队列留在这个画布。Page 1、新画布、页面 1、页面 2 各复制一份工程包。这里不删除原页面，也不刷新正在用的画布标签。</p>
    <button type="button" disabled={busy} onClick={() => void run()} style={{ fontSize: 16, padding: "8px 14px" }}>{busy ? "正在导出…" : "导出各页到新画布"}</button>
    <ul>{lines.map((line, index) => <li key={`${index}-${line.slice(0, 24)}`}>{line}</li>)}</ul>
  </main>;
}
