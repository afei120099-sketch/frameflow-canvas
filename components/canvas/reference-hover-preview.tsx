"use client";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

/** Screen-sized, non-interactive preview; reuse the thumbnail's managed image URL. */
export function ReferenceHoverPreview({ url, name, label }: { url: string; name: string; label: string }) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [position, setPosition] = useState<{ left: number; top: number; width: number; height: number } | null>(null);
  const close = () => { if (timer.current) clearTimeout(timer.current); timer.current = null; setPosition(null); };
  useEffect(() => {
    if (!position) return;
    const dismiss = () => setPosition(null);
    window.addEventListener("pointerdown", dismiss, true);
    window.addEventListener("wheel", dismiss, true);
    window.addEventListener("resize", dismiss);
    window.addEventListener("blur", dismiss);
    window.addEventListener("dragstart", dismiss, true);
    return () => {
      window.removeEventListener("pointerdown", dismiss, true);
      window.removeEventListener("wheel", dismiss, true);
      window.removeEventListener("resize", dismiss);
      window.removeEventListener("blur", dismiss);
      window.removeEventListener("dragstart", dismiss, true);
    };
  }, [position]);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  return <>
    <img src={url} alt={name} decoding="async" draggable={false}
      onMouseEnter={event => {
        close();
        const image = event.currentTarget;
        const bounds = image.getBoundingClientRect();
        timer.current = setTimeout(() => {
          timer.current = null;
          const width = Math.min(300, window.innerWidth - 24);
          const height = Math.min(380, window.innerHeight - 70);
          const left = bounds.right + width + 24 <= window.innerWidth ? bounds.right + 12 : Math.max(12, bounds.left - width - 12);
          setPosition({ left, top: Math.max(12, Math.min(bounds.top, window.innerHeight - height - 54)), width, height });
        }, 220);
      }}
      onMouseLeave={close} onPointerDown={close} onDragStart={close} />
    {position && createPortal(<div className="reference-hover-preview" role="tooltip" style={{ left: position.left, top: position.top, width: position.width }}>
      <img src={url} alt={name} decoding="async" style={{ height: position.height }} draggable={false} />
      <span>{label} · {name}</span>
    </div>, document.body)}
  </>;
}
