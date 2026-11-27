"use client";

import dynamic from "next/dynamic";

const CanvasWorkspace = dynamic(() => import("./canvas-workspace"), {
  ssr: false,
  loading: () => <main className="loading-screen"><div className="loading-mark">∞</div><p>正在打开画布…</p></main>,
});

export default function Home() {
  return <CanvasWorkspace />;
}
