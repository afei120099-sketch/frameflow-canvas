type Box = { type: string; start: number; end: number; content: number };

function ascii(view: DataView, offset: number, length: number) {
  return Array.from({ length }, (_, index) => String.fromCharCode(view.getUint8(offset + index))).join("");
}

function boxes(view: DataView, start: number, end: number): Box[] {
  const found: Box[] = [];
  for (let offset = start; offset + 8 <= end;) {
    let size = view.getUint32(offset);
    const type = ascii(view, offset + 4, 4);
    let header = 8;
    if (size === 1) {
      if (offset + 16 > end) break;
      const large = Number(view.getBigUint64(offset + 8));
      if (!Number.isSafeInteger(large)) break;
      size = large;
      header = 16;
    } else if (size === 0) size = end - offset;
    if (size < header || offset + size > end) break;
    found.push({ type, start: offset, end: offset + size, content: offset + header });
    offset += size;
  }
  return found;
}

function child(view: DataView, parent: Box, type: string) {
  return boxes(view, parent.content, parent.end).find((box) => box.type === type);
}

function timingFromMoov(buffer: ArrayBuffer): {fps:number;frames:number;width?:number;height?:number}|null {
  const view = new DataView(buffer);
  const moov: Box = { type: "moov", start: 0, content: 0, end: view.byteLength };
  for (const trak of boxes(view, moov.content, moov.end).filter((box) => box.type === "trak")) {
    const mdia = child(view, trak, "mdia");
    if (!mdia) continue;
    const hdlr = child(view, mdia, "hdlr");
    const mdhd = child(view, mdia, "mdhd");
    const minf = child(view, mdia, "minf");
    if (!hdlr || !mdhd || !minf || hdlr.content + 12 > hdlr.end || ascii(view, hdlr.content + 8, 4) !== "vide") continue;
    const stbl = child(view, minf, "stbl");
    const stts = stbl && child(view, stbl, "stts");
    if (!stts) continue;
    const version = view.getUint8(mdhd.content);
    const timescaleAt = mdhd.content + (version === 1 ? 20 : 12);
    if (timescaleAt + 4 > mdhd.end || stts.content + 8 > stts.end) continue;
    const timescale = view.getUint32(timescaleAt);
    const entries = view.getUint32(stts.content + 4);
    if (!timescale || stts.content + 8 + entries * 8 > stts.end) continue;
    let frames = 0;
    let ticks = 0;
    for (let index = 0; index < entries; index++) {
      const at = stts.content + 8 + index * 8;
      const count = view.getUint32(at);
      frames += count;
      ticks += count * view.getUint32(at + 4);
    }
    const fps = ticks ? frames * timescale / ticks : 0;
    if (Number.isFinite(fps) && fps >= 1 && fps <= 240) {const tkhd=child(view,trak,"tkhd");return {fps,frames,...(tkhd && tkhd.end-tkhd.content>=8?{width:view.getUint32(tkhd.end-8)/65536,height:view.getUint32(tkhd.end-4)/65536}:{})};}
  }
  return null;
}

/** Reads MP4 timing boxes only; returns null when the file does not expose a readable video FPS. */
export async function readMp4VideoTiming(blob: Blob) {
  let offset = 0;
  while (offset + 8 <= blob.size) {
    const header = new DataView(await blob.slice(offset, offset + 16).arrayBuffer());
    if (header.byteLength < 8) break;
    let size = header.getUint32(0);
    const type = ascii(header, 4, 4);
    if (size === 1) {
      if (header.byteLength < 16) break;
      const large = Number(header.getBigUint64(8));
      if (!Number.isSafeInteger(large)) break;
      size = large;
    } else if (size === 0) size = blob.size - offset;
    if (size < 8 || offset + size > blob.size) break;
    if (type === "moov") {
      if (size > 64 * 1024 * 1024) return null;
      const content = await blob.slice(offset + (header.getUint32(0) === 1 ? 16 : 8), offset + size).arrayBuffer();
      return timingFromMoov(content);
    }
    offset += size;
  }
  return null;
}

export async function readMp4VideoFps(blob:Blob):Promise<number|null>{return (await readMp4VideoTiming(blob))?.fps??null;}

export function formatFps(fps: number) { return Number(fps.toFixed(2)).toString(); }
