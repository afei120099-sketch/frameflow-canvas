"use client";
// Inbox autorun: polls /api/inbox, imports new images through the canvas' own importAssetOnly path,
// writes assets_map.json, and hands resolved *_queue.json to ShotQueuePanel's existing external
// autoSubmit path (parseShotQueue check -> ensureQueuePrimaries -> useShotQueueExecution.submitAll).
import { useInboxScheduler } from "./use-inbox-scheduler";
import { useInboxRootControl } from './use-inbox-root-control';
import { useInboxRoleOps } from './use-inbox-role-ops';
import type { Editor } from "tldraw";
import { createShapeId, type TLShape } from "tldraw";
import { getAsset } from "@/lib/production-records";
import { imageNodeSize } from "@/lib/media-node-layout";


type InboxState = { images: Record<string, { sha256: string; assetId: string; placedOn?: string[] }>; queues: Record<string, { file: string; at: string; result: string; queueJson?: string }> };
const IMAGE_FIELDS = ["firstFrameAssetId", "lastFrameAssetId"] as const;
const IMAGE_NAME = /\.(png|jpe?g|webp)$/i;

/** Replace filename references with asset ids. Returns missing filenames. */
export function resolveQueueFilenames(queue: unknown, map: Record<string, string>) {
  const missing = new Set<string>();
  const fix = (v: unknown) => {
    if (typeof v !== "string" || !IMAGE_NAME.test(v)) return v;
    if (map[v]) return map[v];
    missing.add(v); return v;
  };
  const root = queue as { chapters?: { shots?: Record<string, unknown>[] }[] };
  for (const chapter of root.chapters ?? []) for (const shot of chapter.shots ?? []) {
    for (const key of IMAGE_FIELDS) if (key in shot) shot[key] = fix(shot[key]);
    if (Array.isArray(shot.sceneAssetIds)) shot.sceneAssetIds = shot.sceneAssetIds.map(fix);
  }
  return [...missing];
}


/** Place inbox images on the current page only. An image already recorded in placedOn is not copied onto another page. */
const PLACE_GAP = 60;
async function placeImages(editor: Editor, state: InboxState) {
  const pageId = editor.getCurrentPageId();
  const shapes = [...editor.getPageShapeIds(pageId)].map((id) => editor.getShape(id)!).filter(Boolean);
  const onPage = new Set(shapes.flatMap((s) => { const a = (s.props as { assetId?: string }).assetId; return s.type === "image-node" && a ? [a] : []; }));
  const todo = Object.entries(state.images).filter(([, v]) => !(v.placedOn ?? []).length).sort(([a], [b]) => a.localeCompare(b));
  if (!todo.length) return false;
  const items: { name: string; entry: InboxState["images"][string]; asset: NonNullable<Awaited<ReturnType<typeof getAsset>>>; w: number; h: number }[] = [];
  for (const [name, entry] of todo) {
    if (onPage.has(entry.assetId)) { entry.placedOn = [...(entry.placedOn ?? []), pageId]; continue; }
    const asset = await getAsset(entry.assetId);
    if (!asset || asset.kind !== "image" || !asset.width || !asset.height) { console.warn("[inbox] 无法放置图片", name); continue; }
    const { w, h } = imageNodeSize(asset.width, asset.height);
    items.push({ name, entry, asset, w, h });
  }
  if (items.length) {
    const view = editor.getViewportPageBounds();
    const bottoms = shapes.map((s) => { const b = editor.getShapePageBounds(s); return b ? b.y + b.h : -Infinity; });
    const y = bottoms.length ? Math.max(...bottoms) + 140 : view.center.y;
    const total = items.reduce((t, i) => t + i.w, 0) + PLACE_GAP * (items.length - 1);
    let x = view.center.x - total / 2;
    const ids: TLShape["id"][] = [];
    for (const i of items) {
      const id = createShapeId();
      editor.createShape({ id, type: "image-node", parentId: pageId, x, y, props: { w: i.w, h: i.h, src: i.asset.storageReference, name: i.name, originalPath: i.name, naturalWidth: i.asset.width, naturalHeight: i.asset.height, assetId: i.asset.assetId } } as never);
      if (editor.getShape(id)) { ids.push(id); i.entry.placedOn = [...(i.entry.placedOn ?? []), pageId]; }
      x += i.w + PLACE_GAP;
    }
    if (ids.length && editor.getCurrentPageId() === pageId) { editor.select(...ids); editor.zoomToSelection({ animation: { duration: 0 } }); editor.selectNone(); }
  }
  return true;
}

export function InboxAutorun({ editor, onImportImage, onQueue }: {
  editor: Editor;
  onImportImage: (file: File) => Promise<{ assetId: string }>;
  onQueue: (text: string, deliveryId?: string) => void;
}) {
  useInboxRootControl(editor);
  useInboxRoleOps();
  useInboxScheduler(editor, onImportImage, onQueue, placeImages, resolveQueueFilenames);
  return null;
}
