import { getLocalAudioBlob, getLocalImageBlob, getLocalVideoBlob } from "./local-video-store";

export async function downloadSavedMedia(source: string, name: string, kind: "image" | "video" | "audio") {
  if (!source) throw new Error("媒体文件尚未准备好，无法下载");
  const blob = kind === "image" ? await getLocalImageBlob(source) : kind === "audio" ? await getLocalAudioBlob(source) : await getLocalVideoBlob(source);
  if (!blob.size) throw new Error("媒体文件为空，无法下载");
  const baseName = name.split(/[\\/]/).pop()?.trim() || (kind === "image" ? "image" : kind === "audio" ? "audio" : "video");
  const extension = kind === "video" ? ".mp4" : kind === "audio" ? ".wav" : blob.type === "image/webp" ? ".webp" : blob.type === "image/png" ? ".png" : ".jpg";
  const filename = /\.[a-z0-9]{2,8}$/i.test(baseName) ? baseName : `${baseName}${extension}`;
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.style.display = "none";
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
