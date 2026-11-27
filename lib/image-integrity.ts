import { bounded, fetchBody } from './operation-scope.ts';
export type ImageProof = {
    sha256: string;
    bytes: number;
    width: number;
    height: number;
    mime: string;
};
export async function imageProof(blob: Blob, signal?: AbortSignal): Promise<ImageProof> {
    return bounded(async (scope) => {
        const buffer = await blob.arrayBuffer();
        scope.check();
        const bytes = new Uint8Array(buffer);
        if (!bytes.length || !bytes.some(value => value !== 0))
            throw Error('图片内容为空或全零，禁止上传生成');
        const png = bytes.length > 8 && [137, 80, 78, 71, 13, 10, 26, 10].every((value, i) => bytes[i] === value);
        const jpeg = bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
        const webp = String.fromCharCode(...bytes.slice(0, 4)) === 'RIFF' && String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP';
        if (!png && !jpeg && !webp)
            throw Error('图片文件头无效，禁止把错误响应或坏图送入生成');
        const bitmap = await createImageBitmap(blob).catch(cause => { throw new Error('图片解码失败，禁止提交', { cause }); });
        let width: number, height: number;
        try {
            scope.check();
            width = bitmap.width;
            height = bitmap.height;
            if (!width || !height)
                throw Error('图片解码后尺寸无效');
        }
        finally {
            bitmap.close();
        }
        const digest = await crypto.subtle.digest('SHA-256', buffer);
        scope.check();
        return { sha256: Array.from(new Uint8Array(digest), n => n.toString(16).padStart(2, '0')).join(''), bytes: blob.size, width, height, mime: png ? 'image/png' : jpeg ? 'image/jpeg' : 'image/webp' };
    }, 12000, signal, '图片完整性核实');
}
export async function verifyUploadedImage(blob: Blob, file: {
    name: string;
    subfolder?: string;
}, request: typeof fetch, base: string, signal?: AbortSignal) {
    const before = await imageProof(blob, signal);
    const query = new URLSearchParams({ filename: file.name, subfolder: file.subfolder ?? '', type: 'input' });
    const returned = await fetchBody(base + '/view?' + query, { cache: 'no-store' }, r => r.blob(), 15000, request, signal);
    const after = await imageProof(returned, signal);
    if (before.sha256 !== after.sha256 || before.bytes !== after.bytes)
        throw Error('图片上传前后 SHA-256 不一致；已保留文件，禁止提交 H3');
    return { before, after };
}
