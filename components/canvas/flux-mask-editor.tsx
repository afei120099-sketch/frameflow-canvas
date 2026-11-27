"use client";
import { useEffect, useRef, useState, type PointerEvent } from "react";
import { createPortal } from "react-dom";

export function FluxMaskEditor({ imageUrl, maskUrl, onSave, onClose, purpose }: {
  imageUrl: string; maskUrl?: string; onSave: (blob: Blob) => Promise<void>; onClose: () => void; purpose?: 'alpha';
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const previous = useRef<{ x: number; y: number } | null>(null);
  const [brush, setBrush] = useState(30);
  const [erase, setErase] = useState(false);
  const [ready, setReady] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [ratio, setRatio] = useState(1);
  useEffect(() => {
    let live = true;
    const load = (url: string) => new Promise<HTMLImageElement>((resolve, reject) => {
      const image = new Image(); image.onload = () => resolve(image); image.onerror = () => reject(new Error("图片读取失败")); image.src = url;
    });
    void (async () => {
      const image = await load(imageUrl);
      if (!live || !canvas.current) return;
      const c = canvas.current; c.width = image.naturalWidth; c.height = image.naturalHeight;
      setRatio(c.width / c.height);
      if (maskUrl) {
        const mask = await load(maskUrl);
        if (!live) return;
        if (mask.naturalWidth !== c.width || mask.naturalHeight !== c.height) throw new Error("遮罩尺寸与原图不一致，请重新绘制");
        const ctx = c.getContext("2d")!; ctx.drawImage(mask, 0, 0);
        const pixels = ctx.getImageData(0, 0, c.width, c.height);
        for (let i = 0; i < pixels.data.length; i += 4) {
          pixels.data[i + 3] = pixels.data[i]; pixels.data[i] = pixels.data[i + 1] = pixels.data[i + 2] = 255;
        }
        ctx.putImageData(pixels, 0, 0);
      }
      setReady(true);
    })().catch(e => { if (live) setError(e instanceof Error ? e.message : "遮罩读取失败"); });
    return () => { live = false; };
  }, [imageUrl, maskUrl]);

  const draw = (e: PointerEvent<HTMLCanvasElement>, start: boolean) => {
    if (!ready || saving || (!start && !previous.current)) return;
    const c = e.currentTarget, box = c.getBoundingClientRect();
    const point = { x: (e.clientX - box.left) * c.width / box.width, y: (e.clientY - box.top) * c.height / box.height };
    const ctx = c.getContext("2d")!;
    ctx.globalCompositeOperation = erase ? "destination-out" : "source-over";
    ctx.strokeStyle = "white"; ctx.fillStyle = "white";
    ctx.lineWidth = brush * c.width / box.width; ctx.lineCap = "round"; ctx.lineJoin = "round";
    ctx.beginPath(); ctx.moveTo(previous.current?.x ?? point.x, previous.current?.y ?? point.y); ctx.lineTo(point.x, point.y); ctx.stroke();
    ctx.beginPath(); ctx.arc(point.x, point.y, ctx.lineWidth / 2, 0, Math.PI * 2); ctx.fill();
    previous.current = point;
  };
  const save = async () => {
    const c = canvas.current; if (!c || !ready || saving) return;
    const data = c.getContext("2d")!.getImageData(0, 0, c.width, c.height).data;
    let painted = false;
    for (let i = 3; i < data.length; i += 4) if (data[i]) { painted = true; break; }
    if (!painted) { setError(purpose==='alpha'?"人物遮罩不能全部为空":"请涂出需要修改的区域"); return; }
    setSaving(true); setError("");
    try {
      const output = document.createElement("canvas"); output.width = c.width; output.height = c.height;
      const ctx = output.getContext("2d")!; ctx.fillStyle = "black"; ctx.fillRect(0, 0, output.width, output.height); ctx.drawImage(c, 0, 0);
      const blob = await new Promise<Blob>((resolve, reject) => output.toBlob(b => b ? resolve(b) : reject(new Error("遮罩保存失败")), "image/png"));
      await onSave(blob); onClose();
    } catch (e) { setError(e instanceof Error ? e.message : "遮罩保存失败"); }
    finally { setSaving(false); }
  };
  return createPortal(<div role="dialog" aria-modal="true" aria-label="绘制局部重绘遮罩" className="flux-mask-modal" onPointerDown={e => e.stopPropagation()} onKeyDown={e => e.stopPropagation()}>
    <style>{`.flux-mask-modal{position:fixed;inset:0;z-index:10000;background:rgba(11,11,11,0.87);display:flex;align-items:center;justify-content:center}.flux-mask-panel{width:min(860px,94vw);max-height:94vh;overflow:auto;padding:20px;background:var(--ff-control);border:1px solid var(--ff-text-3);border-radius:14px;color:var(--ff-text)}.flux-mask-panel h3{margin:0 0 8px}.flux-mask-tools{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin:12px 0}.flux-mask-tools button{padding:8px 12px;background:#383838;border:1px solid var(--ff-border-hover);border-radius:7px;color:white;cursor:pointer}.flux-mask-tools button[aria-pressed=true]{background:#595959}.flux-mask-stage{position:relative;margin:auto;max-width:100%;background:var(--ff-canvas)}.flux-mask-stage img{position:absolute;inset:0;width:100%;height:100%;pointer-events:none}.flux-mask-stage canvas{position:relative;display:block;width:100%;height:100%;opacity:.5;touch-action:none;cursor:crosshair}.flux-mask-error{color:var(--ff-bad)}`}</style>
    <div className="flux-mask-panel"><h3>{purpose==='alpha'?'人工补边：人物透明遮罩':'涂出要修改的区域'}</h3><small>{purpose==='alpha'?'白色保留人物，黑色去除背景；画笔补回人物，橡皮擦除多余边缘。保留灰度半透明边缘，不调用GPU。':'白色涂层会重绘；未涂区域保留。改头发时避开脸，换衣服时包含新款式需要的轮廓空间。'}</small>
      <div className="flux-mask-tools"><button type="button" aria-pressed={!erase} disabled={saving} onClick={() => setErase(false)}>画笔</button><button type="button" aria-pressed={erase} disabled={saving} onClick={() => setErase(true)}>橡皮</button><label>画笔大小 <input aria-label="遮罩画笔大小" type="range" min="4" max="120" value={brush} onChange={e => setBrush(Number(e.target.value))} /></label><button type="button" disabled={!ready || saving} onClick={() => canvas.current?.getContext("2d")?.clearRect(0, 0, canvas.current.width, canvas.current.height)}>清空</button></div>
      <div className="flux-mask-stage" style={{ width: `min(100%, ${Math.round(55 * ratio)}vh)`, aspectRatio: ratio }}><img src={imageUrl} alt="局部重绘原图" /><canvas ref={canvas} aria-label="遮罩绘制画布" onPointerDown={e => { previous.current = null; e.currentTarget.setPointerCapture(e.pointerId); draw(e, true); }} onPointerMove={e => draw(e, false)} onPointerUp={() => { previous.current = null; }} onPointerCancel={() => { previous.current = null; }} /></div>
      {error && <p className="flux-mask-error">{error}</p>}
      {purpose==='alpha'&&maskUrl&&<details><summary>本次抠图：黑／白／灰背景检查（补边保存后重新检查）</summary><div style={{display:'flex'}}>{['black','white','gray'].map(bg=><img alt={bg+'背景检查'} key={bg} src={maskUrl.replace(/alpha\.png$/,'check-'+bg+'.png')} style={{width:'33%',maxHeight:240,objectFit:'contain'}}/>)}</div></details>}
      <div className="flux-mask-tools"><button type="button" disabled={!ready || saving} onClick={() => void save()}>{saving ? "保存中…" : purpose==='alpha'?"保存人物alpha":"保存遮罩"}</button><button type="button" disabled={saving} onClick={onClose}>取消</button></div>
    </div>
  </div>, document.body);
}
