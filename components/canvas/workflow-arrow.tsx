"use client";
import { ArrowShapeUtil, Group2d, Polyline2d, SVGContainer, Vec, getArrowBindings, getArrowInfo, renderPlaintextFromRichText, useEditor, useValue, type TLArrowShape, type TLShape, type SvgExportContext } from "tldraw";
import { customTypes } from "@/lib/canvas-node-types";
import { workflowCurve } from "@/lib/workflow-curve";
import { h3PreviewTerminal } from "@/lib/media-node-layout";

function WorkflowLinkLabel({ shape, point }: { shape: TLArrowShape; point: { x: number; y: number } }) {
  const editor = useEditor();
  const detailVisible = useValue("edge detail visibility", () => editor.getZoomLevel() >= 0.48, [editor]);
  const label = useValue("workflow edge role label", () => {
    const bindings = getArrowBindings(editor, shape);
    const from = bindings.start && editor.getShape(bindings.start.toId);
    const to = bindings.end && editor.getShape(bindings.end.toId);
    const role = shape.meta.frameRole;
    if (to?.type === "h3-node" && (to.props as { extensionSourceVideo?: unknown }).extensionSourceVideo) return "视频延长";
    if (role === "guide") return `分镜参考 ${Number(shape.meta.guideSlot ?? 0) + 1}`;
    if (role === "reference") return "参考素材";
    if (role === "last") return "尾帧";
    if (from?.type === "audio-node") return "声音参考";
    if ((from?.type === "image-node" || from?.type === "flux-image-node") && to?.type === "flux-image-node") return "图生图原图";
    if ((from?.type === "image-node" || from?.type === "flux-image-node") && to?.type === "h3-node") {
      const y = bindings.end?.props.normalizedAnchor.y ?? 0.5;
      return Math.abs(y - 0.34) < 0.035 ? "参考素材" : Math.abs(y - 0.25) < 0.035 ? "尾帧" : "首帧";
    }
    return to?.type === "upscale-node" ? "高清修复" : to?.type === "smooth-node" ? "插帧" : "视频输入";
  }, [editor, shape]);
  if (!detailVisible) return null;
  return <g className="workflow-link-label" pointerEvents="none"><rect x={point.x - 44} y={point.y - 26} width={88} height={22} rx={6} fill="#1b1b1b" stroke="#585858" /><text x={point.x} y={point.y - 11} textAnchor="middle" fill="#e5e5e5" stroke="none" fontSize={11}>{label}</text></g>;
}

/** Keep tldraw's arrow IDs, bindings, Undo and terminal editing. Only workflow
 * links get this presentation; ordinary drawing arrows remain unchanged. */
export class WorkflowArrowUtil extends ArrowShapeUtil {
  // The built-in renderer uses hooks. Keep it in its own React component so
  // completing a binding never changes the hook count of the shape renderer.
  private DefaultArrow = ({ shape }: { shape: TLArrowShape }) => super.component(shape);
  /** Presentation only: leave stored input roles and bindings untouched. */
  private previewTerminal(arrow: TLArrowShape, node: TLShape, side: "left" | "right", fallback: { x: number; y: number }) {
    const props = node.props as { w?: number; previewWidth?: number; previewHeight?: number };
    if (!props.w || !props.previewWidth || !props.previewHeight) return fallback;
    // Store-backed dimensions invalidate reactive arrow geometry on media changes.
    // DOM measurements are not reactive and may be missing/stale after hydration.
    const page = this.editor.getShapePageTransform(node).applyToPoint(h3PreviewTerminal(props.w, { w: props.previewWidth, h: props.previewHeight }, side));
    return this.editor.getPointInShapeSpace(arrow, page);
  }
  private curve(shape: TLArrowShape) {
    if (renderPlaintextFromRichText(this.editor, shape.props.richText).trim()) return null;
    const bindings = getArrowBindings(this.editor, shape);
    const from = bindings.start && this.editor.getShape(bindings.start.toId);
    const to = bindings.end && this.editor.getShape(bindings.end.toId);
    if (!from || !to || !customTypes.has(from.type) || !customTypes.has(to.type)) return null;
    const info = getArrowInfo(this.editor, shape);
    if (!info) return null;
    const start = from.type === "h3-node" ? this.previewTerminal(shape, from, "right", info.start.point) : info.start.point;
    const end = to.type === "h3-node" ? this.previewTerminal(shape, to, "left", info.end.point) : info.end.point;
    return workflowCurve(start, end);
  }
  override getGeometry(shape: TLArrowShape) {
    const curve = this.curve(shape);
    return curve ? new Group2d({ children: [new Polyline2d({ points: curve.points.map(p => new Vec(p.x, p.y)) })] }) : super.getGeometry(shape);
  }
  override component(shape: TLArrowShape) {
    const curve = this.curve(shape);
    return curve ? <SVGContainer><g stroke="var(--ff-arrow-stroke,var(--ff-link,#707070))"><g style={{ clipPath: "none" }}><path className="workflow-curve" d={curve.path} fill="none" strokeWidth={1.6} strokeLinecap="round" /></g><WorkflowLinkLabel shape={shape} point={curve.points[24]} /></g></SVGContainer> : <this.DefaultArrow shape={shape} />;
  }
  override getIndicatorPath(shape: TLArrowShape) {
    const curve = this.curve(shape);
    return curve ? new Path2D(curve.path) : super.getIndicatorPath(shape);
  }
  override getHandles(shape: TLArrowShape) {
    const handles = super.getHandles(shape);
    return this.curve(shape) ? handles?.filter(h => h.id === "start" || h.id === "end") : handles;
  }
  override toSvg(shape: TLArrowShape, ctx: SvgExportContext) {
    const curve = this.curve(shape);
    return curve ? <path d={curve.path} fill="none" stroke="#707070" strokeWidth={1.6} /> : super.toSvg(shape, ctx);
  }
}
