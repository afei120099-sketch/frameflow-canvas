"use client";
import { useValue, type Editor, type TLShape } from "tldraw";
import { attachCompletedRunToShot, getShot, getAsset } from "@/lib/production-records";
import { useRunRecovery } from "./run-recovery-view";

/** Recovery is outside culled media cards and the queue drawer. It never submits a job. */
function QueueNodeRecovery({ editor, id }: { editor: Editor; id: string }) {
  useRunRecovery(id, () => false, async (run, asset) => {
    if (!run.shotId) return;
    await attachCompletedRunToShot(run.shotId, run.runId);
    const shot = await getShot(run.shotId);
    const display = shot?.adoptedAssetId ? await getAsset(shot.adoptedAssetId) : asset;
    const node = editor.getShape(id as TLShape["id"]);
    if (node?.type === "h3-node" && display) editor.updateShape({ id: node.id, type: "h3-node", props: { previewAssetId: display.assetId } });
  });
  return null;
}

export function ShotQueueRecovery({ editor }: { editor: Editor }) {
  const key = useValue("durable queue recovery nodes", () => JSON.stringify(editor.getCurrentPageShapes()
    .filter(node => node.type === "h3-node" && (typeof node.meta.shotQueueSessionId === "string" || node.meta.toolkitRecovery === true)).map(node => node.id).sort()), [editor]);
  // These lightweight watchers remain mounted even when media cards are outside the viewport.
  const ids = JSON.parse(key) as string[];
  return <>{ids.map(id => <QueueNodeRecovery key={id} editor={editor} id={id} />)}</>;
}
