import { bounded, fetchBody } from './operation-scope.ts';
import { imageProof, type ImageProof } from './image-integrity.ts';
import { getAsset, getMeta, type RunRecord } from './production-records.ts';
import { getLocalImageBlob } from './local-video-store.ts';
import { tailFrameEnhanceKey } from './tail-frame-hd-job.ts';
import type { QueueFrameInput } from './shot-queue-frames.ts';
/** Read-only evidence. Never swaps a source, repairs a Blob, or submits a prompt. */
export async function auditQueueFrame(frame: QueueFrameInput, run?: RunRecord) {
    return bounded(async (scope) => {
        type Evidence = {
            location: string;
            assetId?: string;
            proof?: ImageProof;
            error?: string;
        };
        const evidence: Evidence[] = [];
        const inspect = async (location: string, read: () => Promise<Blob>, assetId?: string) => {
            try {
                const blob = await read();
                scope.check();
                const proof = await imageProof(blob, scope.signal);
                evidence.push({ location, assetId, proof });
            }
            catch (error) {
                scope.check();
                evidence.push({ location, assetId, error: String(error) });
            }
        };
        await inspect('entry.frameInputs / pre-upload IDB Blob', () => getLocalImageBlob(frame.src));
        const originalId = frame.enhancement?.originalAssetId;
        const metadata = originalId ? await getMeta<{
            promptId?: string;
            completedAssetId?: string;
        }>(tailFrameEnhanceKey(originalId)) : null;
        scope.check();
        for (const [label, id] of [['original extracted frame', originalId], ['completed HD asset', metadata?.completedAssetId ?? frame.enhancement?.completedAssetId]] as const) {
            if (!id)
                continue;
            const asset = await getAsset(id);
            scope.check();
            if (asset)
                await inspect(label, () => getLocalImageBlob(asset.storageReference), id);
            else
                evidence.push({ location: label, assetId: id, error: 'Asset unavailable; no replacement attempted' });
        }
        const graph = run?.submissionSnapshot?.graph;
        const inputNames = [...new Set(Object.values(graph ?? {}).filter(node => node.class_type === 'LoadImage' && typeof node.inputs.image === 'string').map(node => String(node.inputs.image)))];
        // Report every actual LoadImage, without guessing which reference is the tail.
        for (const name of inputNames) {
            const parts = name.split('/'), filename = parts.pop()!;
            await inspect('Comfy received input: ' + name, () => fetchBody('/comfyui/view?' + new URLSearchParams({ filename, subfolder: parts.join('/'), type: 'input' }), { cache: 'no-store' }, response => response.blob(), 6000, fetch, scope.signal));
        }
        const preUpload = evidence.find(item => item.location.startsWith('entry.frameInputs'))?.proof;
        return { sourceRunId: frame.sourceRunId, sourceAssetId: frame.sourceAssetId, enhancement: frame.enhancement, hdMetadata: metadata, runId: run?.runId, promptId: run?.comfyPromptId, evidence, inputMatchesPreUpload: evidence.filter(item => item.location.startsWith('Comfy received')).map(item => ({ location: item.location, match: preUpload && item.proof ? preUpload.sha256 === item.proof.sha256 : null })), note: 'No upload-time hash exists for old runs. Matching sizes or a valid candidate PNG alone do not prove lineage.' };
    }, 25000, undefined, '首尾帧只读完整性诊断');
}
