"use client";
// One-shot relocation of the "七位仙子" image nodes onto the page named 仙侠, plus target-page lookup for the inbox.
import type { Editor, TLPageId, TLShape } from "tldraw";
import { createShapeId, toRichText } from "tldraw";

export const XIANXIA_PAGE_NAME = "\u4ed9\u4fa0";
export const xianxiaPageId = (editor: Editor): TLPageId | null =>
  editor.getPages().find((p) => p.name.trim() === XIANXIA_PAGE_NAME)?.id ?? null;

const VOID_IDS = new Set(["6c08ba27-489b-4f91-9341-9cc4c6adbc01", "9ab0d5a7-8de3-48c3-9b31-7eb5eb6f709f", "4c8695d8-1cb2-4c26-8d72-0ec70c4f856f"]);
const EXCLUDE_IDS = new Set(["fe29c9d1-4117-406c-9f8c-c5c65b0ff133", "084ad0d7-5794-4480-b106-25783e034002"]); // wedding A02 / 空台话筒
const SCENE = /(\u4e91\u53f0|\u4ed9\u53f0|\u6e21\u53e3|\u9662\u5916\u6668|\u5916\u95f4\u591c|\u5367\u623f\u591c)/;
const FLAG = "ff-xianxia-relocate-v1";

type Img = { id: TLShape["id"]; page: string; name: string; assetId: string; w: number; h: number };

export function relocateXianxia(editor: Editor, map: Record<string, string>) {
  const target = xianxiaPageId(editor);
  if (!target) return { error: "no page named xianxia", pages: editor.getPages().map((p) => ({ id: p.id, name: p.name })) };
  const ours = new Set(Object.entries(map).filter(([n, id]) => !EXCLUDE_IDS.has(id) && !n.startsWith("A02_")).map(([, id]) => id));
  const pageOf = (s: TLShape): string => { let p: string = s.parentId; while (!p.startsWith("page:")) { const par = editor.getShape(p as TLShape["id"]); if (!par) break; p = par.parentId; } return p; };
  const all = editor.getPages().flatMap((pg) => [...editor.getPageShapeIds(pg.id)].map((id) => editor.getShape(id)!).filter(Boolean));
  const imgs: Img[] = all.filter((s) => s.type === "image-node").map((s) => { const pr = s.props as { name?: string; assetId?: string; w: number; h: number }; return { id: s.id, page: pageOf(s), name: pr.name ?? "", assetId: pr.assetId ?? "", w: pr.w, h: pr.h, top: s.parentId.startsWith("page:") }; })
    .filter((i) => !EXCLUDE_IDS.has(i.assetId) && (ours.has(i.assetId) || i.name.startsWith("EP01_") || SCENE.test(i.name))) as Img[];
  const before = imgs.map((i) => ({ ...i }));
  const toMove = imgs.filter((i) => i.page !== target && editor.getShape(i.id)!.parentId.startsWith("page:"));
  const nested = imgs.filter((i) => i.page !== target && !editor.getShape(i.id)!.parentId.startsWith("page:"));
  const targetShapes = [...editor.getPageShapeIds(target)].map((id) => editor.getShapePageBounds(id)).filter(Boolean) as { x: number; y: number; w: number; h: number }[];
  const minX = targetShapes.length ? Math.min(...targetShapes.map((b) => b.x)) : 0;
  const maxX = targetShapes.length ? Math.max(...targetShapes.map((b) => b.x + b.w)) : 0;
  let y = targetShapes.length ? Math.max(...targetShapes.map((b) => b.y + b.h)) + 300 : 0;
  const GAP = 60, PER_ROW = 6;
  const good = toMove.filter((i) => !VOID_IDS.has(i.assetId)).sort((a, b) => a.name.localeCompare(b.name));
  const bad = toMove.filter((i) => VOID_IDS.has(i.assetId)).sort((a, b) => a.name.localeCompare(b.name));
  const placed: { id: string; name: string; assetId: string; from: string; x: number; y: number; void: boolean }[] = [];
  let labelId: string | null = null;
  editor.run(() => {
    let index = editor.getHighestIndexForParent(target);
    const put = (i: Img, x: number, yy: number, v: boolean) => {
      editor.updateShapes([{ id: i.id, type: "image-node", parentId: target, index, x, y: yy } as never]);
      index = (editor.getHighestIndexForParent(target));
      placed.push({ id: i.id, name: i.name, assetId: i.assetId, from: i.page, x, y: yy, void: v });
    };
    let rowRight = minX;
    for (let r = 0; r < good.length; r += PER_ROW) {
      const row = good.slice(r, r + PER_ROW); let x = minX; const rh = Math.max(...row.map((i) => i.h));
      for (const i of row) { put(i, x, y, false); x += i.w + GAP; }
      rowRight = Math.max(rowRight, x); y += rh + GAP;
    }
    if (bad.length) {
      const vx = Math.max(rowRight, maxX) + 400; const vy = (targetShapes.length ? Math.max(...targetShapes.map((b) => b.y + b.h)) + 300 : 0);
      const lid = createShapeId(); labelId = lid;
      editor.createShape({ id: lid, type: "text", parentId: target, x: vx, y: vy - 120, props: { richText: toRichText("\u4f5c\u5e9f\uff08\u4e0d\u8981\u7528\uff09\uff1aS01 \u88c1\u526a\u7248 / v3\u6269\u753b\uff0c\u961f\u5217\u7528 v2"), size: "l", color: "red" } } as never);
      let x = vx;
      for (const i of bad) { put(i, x, vy, true); x += i.w + GAP; }
    }
  });
  const after = imgs.map((i) => { const s = editor.getShape(i.id); return { id: i.id, name: i.name, assetId: i.assetId, page: s ? pageOf(s) : "missing" }; });
  return { target, pages: editor.getPages().map((p) => ({ id: p.id, name: p.name })), before, placed, nested: nested.map((n) => ({ id: n.id, name: n.name, page: n.page })), labelId, after, allOnTarget: after.every((a) => a.page === target) };
}

export async function runXianxiaRelocateOnce(editor: Editor, project: string, map: Record<string, string>, write: (p: string, n: string, v: unknown) => Promise<void>) {
  if (localStorage.getItem(FLAG)) return;
  const backup = editor.getPages().flatMap((pg) => [...editor.getPageShapeIds(pg.id)].map((id) => editor.getShape(id)).filter((s) => s?.type === "image-node"));
  await write(project, "_xianxia_relocate_backup.json", { at: new Date().toISOString(), shapes: backup });
  const report = relocateXianxia(editor, map);
  if ("error" in report) { await write(project, "_xianxia_relocate_report.json", { at: new Date().toISOString(), ...report }); return; }
  localStorage.setItem(FLAG, new Date().toISOString());
  await write(project, "_xianxia_relocate_report.json", { at: new Date().toISOString(), ...report });
}