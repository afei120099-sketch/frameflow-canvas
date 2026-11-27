"use client";
// Inbox delete command: <收件箱>/<project>/_delete.json = { "assetIds": ["..."] }.
// Removes image-node shapes with those assetIds from the active page ONLY, through the canvas' own
// removal guard (inspectNodeRemoval). Library asset records are not touched.
// Before deleting, the matching shapes + asset records are backed up to _delete_<stamp>_backup_status.json.
// Result goes to _delete_status.json; a command (by content hash) runs once.
import type { Editor, TLShape, TLShapeId } from "tldraw";
import { getAsset } from "@/lib/production-records";
import { inspectNodeRemoval } from "@/lib/node-removal-guard";

type Files = { name: string }[];
type Write = (project: string, name: string, value: unknown) => Promise<void>;
type Status = { commandSha?: string; state: string; at: string; [k: string]: unknown };

export async function runInboxDelete(editor: Editor, project: string, files: Files, write: Write) {
  if (!files.some((f) => f.name === "_delete.json")) return;
  const read = async <T,>(name: string): Promise<T | null> => {
    if (!files.some((f) => f.name === name)) return null;
    const r = await fetch(`/api/inbox?${new URLSearchParams({ op: "file", project, name })}`, { cache: "no-store" });
    return r.ok ? ((await r.json()) as T) : null;
  };
  const raw = await (await fetch(`/api/inbox?${new URLSearchParams({ op: "file", project, name: "_delete.json" })}`, { cache: "no-store" })).text();
  const cmd = { sha256: [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(raw)))].map((x) => x.toString(16).padStart(2, "0")).join("") };
  const prev = await read<Status>("_delete_status.json");
  if (prev?.commandSha === cmd.sha256 && ["done", "refused", "rejected"].includes(prev.state)) return;
  const at = new Date().toISOString();
  const report = (state: string, extra: Record<string, unknown>) => write(project, "_delete_status.json", { commandSha: cmd.sha256, state, at, ...extra });
  let body: { assetIds?: unknown } | null = null; try { body = JSON.parse(raw); } catch { /* rejected below */ }
  const ids = Array.isArray(body?.assetIds) ? body!.assetIds.filter((x): x is string => typeof x === "string" && /^[0-9a-f-]{36}$/i.test(x)) : [];
  if (!ids.length) return report("rejected", { error: "_delete.json 需要 { assetIds: [uuid...] }" });
  const page = editor.getCurrentPageId();
  const want = new Set(ids);
  const shapes = [...editor.getPageShapeIds(page)].map((id) => editor.getShape(id)).filter((s): s is TLShape =>
    !!s && s.type === "image-node" && s.parentId === page && want.has(((s.props as { assetId?: string }).assetId) ?? ""));
  const found = new Set(shapes.map((s) => (s.props as { assetId: string }).assetId));
  const notOnPage = ids.filter((id) => !found.has(id));
  if (!shapes.length) return report("done", { deleted: [], notOnPage });
  const assets: { assetId: string; record: Awaited<ReturnType<typeof getAsset>> }[] = [];
  try { for (const id of found) assets.push({ assetId: id, record: await getAsset(id) }); }
  catch (error) { return report("refused", { reason: "unreadable", message: "读取素材记录失败，未删除节点", error: error instanceof Error ? error.message : String(error), notOnPage }); }
  const backupName = `_delete_${at.replace(/[:.]/g, "-")}_backup_status.json`;
  await write(project, backupName, { at, page, shapes, assets });
  if (editor.getCurrentPageId() !== page) return report("waiting", { message: "页面已切换，未删除节点", backup: backupName });
  const check = await inspectNodeRemoval(editor, shapes.map((s) => s.id as TLShapeId));
  if (!check.ok) return report("refused", { reason: check.reason, message: check.message, backup: backupName, notOnPage });
  if (editor.getCurrentPageId() !== page) return report("waiting", { message: "页面已切换，未删除节点", backup: backupName });
  editor.deleteShapes(check.ids);
  const left = [...editor.getPageShapeIds(page)].map((id) => editor.getShape(id)).filter((s) => s?.type === "image-node" && want.has(((s!.props as { assetId?: string }).assetId) ?? ""));
  return report(left.length ? "partial" : "done", { page, deleted: shapes.map((s) => ({ shapeId: s.id, assetId: (s.props as { assetId: string }).assetId, name: (s.props as { name?: string }).name })), stillOnPage: left.map((s) => s!.id), notOnPage, backup: backupName });
}
