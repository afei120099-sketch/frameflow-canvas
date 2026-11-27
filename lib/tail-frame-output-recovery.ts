import { boundedLock, fetchBody } from './operation-scope.ts';
import { imageProof } from './image-integrity.ts';
import { getAsset, getMeta, listAllAssets, patchMeta, registerAsset, putMeta } from './production-records.ts';
import { getLocalImageBlob, storeLocalImage } from './local-video-store.ts';
import { tailFrameEnhanceKey } from './tail-frame-hd-job.ts';
export type TailOutputRecovery = {
    retireUnexecutedHeld?:boolean;
    originalAssetId: string;
    promptId: string;
    filename: string;
    expectedOutputSha256: string;
    expectedOriginalSha256: string;
};
/** ComfyUI SaveImage embeds the executed graph as an uncompressed PNG tEXt chunk. */
export function pngPrompt(bytes: Uint8Array): Record<string, {
    class_type: string;
    inputs: Record<string, unknown>;
    is_changed?: unknown[];
}> {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let offset = 8;
    while (offset + 12 <= bytes.length) {
        const size = view.getUint32(offset), end = offset + 12 + size;
        if (end > bytes.length)
            throw Error('PNG块越界');
        const type = new TextDecoder().decode(bytes.subarray(offset + 4, offset + 8));
        if (type === 'tEXt') {
            const body = bytes.subarray(offset + 8, offset + 8 + size), zero = body.indexOf(0);
            if (zero >= 0 && new TextDecoder().decode(body.subarray(0, zero)) === 'prompt')
                return JSON.parse(new TextDecoder().decode(body.subarray(zero + 1)));
        }
        offset = end;
    }
    throw Error('原高清PNG没有可核实的工作流元数据；不会猜测恢复');
}
/** Only recognize a proven existing output. No GPU POST, no deletion, no session/Run editing. */
export async function recoverTailOutput(target: TailOutputRecovery, signal?: AbortSignal) {
    const result = await boundedLock('frameflow-tail-hd-reserve:' + target.originalAssetId, async (scope) => {
        const check = () => scope.check();
        if (!/^Frameflow_Frame_HD_\d+_\.png$/.test(target.filename) || ![target.expectedOriginalSha256, target.expectedOutputSha256].every(value => /^[a-f0-9]{64}$/.test(value)))
            throw Error('恢复需要明确原输出名和两段SHA-256');
        const key = tailFrameEnhanceKey(target.originalAssetId), prior = await getMeta<{
            promptId?: string;
            completedAssetId?: string;
        }>(key);
        check();
        if (prior?.promptId !== target.promptId)
            throw Error('原增强promptId不符，不恢复');
        const original = await getAsset(target.originalAssetId);
        check();
        if (!original || original.recycled)
            throw Error('原截帧已丢失或回收');
        const originalProof = await imageProof(await getLocalImageBlob(original.storageReference), scope.signal);
        check();
        if (originalProof.sha256 !== target.expectedOriginalSha256)
            throw Error('原截帧SHA-256不符');
        const image = await fetchBody('/comfyui/view?' + new URLSearchParams({ filename: target.filename, type: 'output', subfolder: '' }), { cache: 'no-store' }, response => response.blob(), 12000, fetch, scope.signal);
        const proof = await imageProof(image, scope.signal);
        check();
        if (proof.sha256 !== target.expectedOutputSha256)
            throw Error('高清原输出SHA-256不符');
        const graph = pngPrompt(new Uint8Array(await image.arrayBuffer()));
        check();
        if (!Object.values(graph).some(node => node.class_type === 'LoadImage' && node.is_changed?.includes(originalProof.sha256)))
            throw Error('PNG工作流不能证明使用了本镜原截帧');
        if (graph['66:59']?.inputs.color_correction_method !== 'lab')
            throw Error('原高清输出未启用原帧色彩匹配，不擅自替换');
        let asset = (await listAllAssets('image')).find(item => !item.recycled && item.enhancementPromptId === target.promptId && item.imageIntegrity?.sha256 === proof.sha256 && item.sourceAssetIds?.includes(original.assetId));
        check();
        if (!asset) {
            const src = await storeLocalImage(image, target.filename, scope.signal);
            check();
            const readBack = await imageProof(await getLocalImageBlob(src), scope.signal);
            check();
            if (readBack.sha256 !== proof.sha256)
                throw Error('恢复图IDB读回不一致，未挂接');
            asset = await registerAsset({ kind: 'image', origin: 'generated', filename: target.filename, mimeType: 'image/png', storageReference: src, sourceRunId: null, width: proof.width, height: proof.height, fileSize: proof.bytes, sourceAssetIds: [original.assetId], sourceVideoAssetId: original.sourceVideoAssetId, sourceStartTime: original.sourceStartTime, canvasPageIds: original.canvasPageIds, imageIntegrity: proof, enhancementPromptId: target.promptId }, scope.signal);
        }
        check();
        const receipt = { ...target, recoveredAssetId: asset.assetId, previousCompletedAssetId: prior?.completedAssetId ?? null, at: new Date().toISOString(), originalProof, proof };
        await patchMeta<typeof receipt>('tail-output-recovery:' + target.originalAssetId + ':' + target.promptId, current=>current??receipt,scope.signal);
        check();
        await patchMeta<{
            promptId?: string;
            completedAssetId?: string;
        }>(key, current => { if (current?.promptId !== target.promptId || current.completedAssetId !== prior?.completedAssetId)
            throw Error('增强元数据发生并发变化'); return { ...current, completedAssetId: asset!.assetId }; }, scope.signal);
        return { asset, receipt };
    }, { signal, waitMs: 1000, workMs: 25000 });
    if (!result)
        throw Error('原尾帧正在核实');
    return result;
}
