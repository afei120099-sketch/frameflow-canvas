"use client";
// Stage I: canvas chrome (toolbar, style dock, background, link overlay) extracted without behaviour change.
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { bindCanvasInteraction } from '@/lib/canvas-interaction';
import { ArrowToolbarItem, DefaultStylePanel, DefaultToolbar, HandToolbarItem, NoteToolbarItem, SelectToolbarItem, TextToolbarItem, getArrowBindings, useEditor, useValue, type TLArrowShape, type TLUiStylePanelProps } from "tldraw";
import { ChevronLeft, ChevronRight, Palette } from "lucide-react";
import { getGeneratingSnapshot, linkStyleRules, subscribeGenerating, type Link } from "@/lib/link-highlight";
import { FAR_ZOOM } from "@/lib/media-activation";
import { customTypes } from "@/lib/canvas-node-types";
import { FluxImageEntry } from "./flux-image-entry";

const stopPropagation = (event: React.SyntheticEvent) => event.stopPropagation();

export function CreativeToolbar() {
  return <DefaultToolbar minItems={6} maxItems={6}>
    <SelectToolbarItem />
    <HandToolbarItem />
    <ArrowToolbarItem />
    <TextToolbarItem />
    <NoteToolbarItem />
    <FluxImageEntry />
  </DefaultToolbar>;
}

export function CollapsibleStylePanel(props: TLUiStylePanelProps) {
  const editor = useEditor();
  const [isOpen, setIsOpen] = useState(false);
  const hasCustomSelection = useValue("frameflow custom selection for style dock", () => editor.getSelectedShapes().some((shape) => customTypes.has(shape.type)), [editor]);

  if (hasCustomSelection) return null;

  return <div className={`collapsible-style-panel${isOpen ? " is-open" : ""}`}>
    <button
      type="button"
      className="style-panel-toggle"
      aria-label={isOpen ? "收起样式面板" : "打开样式面板"}
      title={isOpen ? "收起样式面板" : "打开样式面板"}
      aria-expanded={isOpen}
      onPointerDown={stopPropagation}
      onClick={(event) => { event.stopPropagation(); setIsOpen((current) => !current); }}
    >
      <Palette size={16} />
      {isOpen && <span>样式</span>}
      {isOpen ? <ChevronRight size={16} /> : <ChevronLeft size={14} />}
    </button>
    {isOpen && <DefaultStylePanel {...props} />}
  </div>;
}

export function CameraDotBackground() {
  const editor = useEditor();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    let frame = 0;
    const paint = () => {
      frame = 0;
      const camera = editor.getCamera();
      const spacing = 26 * camera.z;
      const major = spacing * 4;
      const offset = `${camera.x * camera.z}px ${camera.y * camera.z}px`;
      const minor = Math.max(0, Math.min(1, (spacing - 7) / 10));
      element.style.backgroundSize = `${major}px ${major}px, ${spacing}px ${spacing}px`;
      element.style.backgroundPosition = `${offset}, ${offset}`;
      element.style.opacity = String(Math.max(0.12, Math.min(0.34, 0.14 + camera.z * 0.16)));
      element.style.setProperty("--ff-minor-dot", String(minor));
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(paint); };
    schedule();
    const off = editor.store.listen(schedule, { scope: "session" });
    return () => { off(); if (frame) cancelAnimationFrame(frame); };
  }, [editor]);
  return <div ref={ref} className="camera-dot-background" />;
}

/**
 * Workflow link emphasis (UI V1): quiet by default, the selected node's chain stands out, the hovered
 * node's direct links brighten, and links feeding a generating node flow slowly (static at far zoom).
 * Rules come from lib/link-highlight.ts; the link list is a string key so dragging does not re-render.
 */
export function ConnectionHighlightOverlay() {
  const editor = useEditor();
  const pageId=useValue('workflow link page',()=>editor.getCurrentPageId(),[editor]);
  const [linkKey,setLinkKey]=useState('');
  useEffect(()=>bindCanvasInteraction(editor.getContainer()),[editor]);
  useEffect(()=>{
    let alive=true,pending=false;
    const refresh=()=>{if(pending)return;pending=true;queueMicrotask(()=>{pending=false;if(!alive)return;setLinkKey(editor.getCurrentPageShapes().flatMap(candidate=>{
      if(candidate.type!=='arrow')return [];
      const bindings=getArrowBindings(editor,candidate as TLArrowShape);
      return bindings.start&&bindings.end?[`${candidate.id}\u0001${bindings.start.toId}\u0001${bindings.end.toId}`]:[];
    }).join('\u0002'));});};
    refresh();
    const off=editor.store.listen(({changes})=>{
      // Position/parameter changes do not alter the link graph. Avoid an O(all nodes)
      // reactive scan on every drag frame or status update.
      const topology=Object.keys(changes.added).length||Object.keys(changes.removed).length||Object.values(changes.updated).some(([before,after])=>before.typeName==='binding'||after.typeName==='binding'||before.typeName==='shape'&&after.typeName==='shape'&&before.parentId!==after.parentId);
      if(topology)refresh();
    },{scope:'document'});
    return()=>{alive=false;off();};
  },[editor,pageId]);
  const selectedId = useValue("frameflow selected workflow node", () => { const ids = editor.getSelectedShapeIds(); const shape = ids.length === 1 ? editor.getShape(ids[0]) : undefined; return shape && customTypes.has(shape.type) ? shape.id : null; }, [editor]);
  const hoveredId = useValue("frameflow hovered workflow node", () => { const id = editor.getHoveredShapeId(); const shape = id ? editor.getShape(id) : undefined; return shape && customTypes.has(shape.type) ? shape.id : null; }, [editor]);
  const far = useValue("frameflow far zoom for links", () => editor.getZoomLevel() < FAR_ZOOM, [editor]);
  const generating = useSyncExternalStore(subscribeGenerating, getGeneratingSnapshot, () => "");
  const css = useMemo(() => {
    const links: Link[] = linkKey ? linkKey.split("\u0002").map((entry) => { const [id, from, to] = entry.split("\u0001"); return { id, from, to }; }) : [];
    return linkStyleRules({ links, selectedId, hoveredId, generatingIds: new Set(generating ? generating.split(",") : []), zoom: far ? 0 : 1 });
  }, [linkKey, selectedId, hoveredId, generating, far]);
  return css ? <style>{css}</style> : null;
}

