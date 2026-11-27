"use client";
import { CopyPromptButton } from "./copy-prompt-button";
import { readH3Roles } from "@/lib/h3-role-snapshot";
import type { H3DialogueLine } from '@/lib/h3-dialogue';
import { useEffect, useState, type RefObject } from "react";
import { useImageThumbnail } from "@/components/canvas/use-image-thumbnail";
import { buildReferenceManifest, type PictureSource } from "@/lib/reference-manifest";
import { getAsset, getAssetBySource } from "@/lib/production-records";
import { getRole } from "@/lib/role-records";
import { insertMention, mentionQuery, referencedLabels, type MentionItem } from "@/lib/reference-mentions";
import { voiceReferenceLabels } from "@/lib/voice-reference-status";
import { VoiceSubmissionStatus } from "./voice-submission-status";

export interface MentionSpec {
  images: { src: string; name: string; source: Exclude<PictureSource, "role_appearance">; nodeId?: string }[];
  videos: { src: string; name: string; withAudio?: boolean }[];
  audios: { src: string; name: string }[];
  roleIds: string[];
  dialogue: H3DialogueLine[];
  voiceRoleId?: string;
  voiceRoleIds?: string[];
  offscreenRoleIds?: string[];
  roleRevision?: string;
  roleSnapshot?: string;
  soundMode: "av" | "ambient" | "silent";
  includeRoleVoices?: boolean;
}
/** Read-only preview uses the same manifest builder as submission, including role and soundtrack ordinals. */
export async function readMentionData(spec: MentionSpec) {
  const explicit = async (item: { src: string; name: string; withAudio?: boolean }) => {
    const asset = await getAssetBySource(item.src);
    return { assetId: asset?.assetId ?? `preview:${item.src}`, storageReference: item.src, filename: item.name, withAudio: item.withAudio };
  };
  const [images, videos, audios, roleData] = await Promise.all([
    Promise.all(spec.images.map(async item => ({ ...await explicit(item), source: item.source }))),
    Promise.all(spec.videos.map(explicit)), Promise.all(spec.audios.map(explicit)),
    readH3Roles(spec, spec.roleSnapshot, getRole, getAsset),
  ]);
  const manifest = buildReferenceManifest({ images, videos, audios, ...roleData, dialogue: spec.dialogue, voiceRoleId: spec.voiceRoleId, voiceRoleIds: spec.voiceRoleIds, offscreenRoleIds: spec.offscreenRoleIds, soundMode: spec.soundMode, includeRoleVoices: spec.includeRoleVoices });
  const imageItems: MentionItem[] = manifest.pictureRefs.map(item => ({ label: item.label, name: item.filename, src: item.storageReference, kind: "image", nodeId: spec.images.find(source => source.src === item.storageReference)?.nodeId }));
  const items: MentionItem[] = [...imageItems,
    ...manifest.videoRefs.map(item => ({ label: item.label, name: item.filename, src: item.storageReference, kind: "video" as const })),
    ...manifest.audioRefs.map(item => ({ label: item.label, name: item.kind === "video_soundtrack" ? `${item.filename} · 视频声音` : item.filename, src: item.storageReference, kind: "audio" as const })),
    ...manifest.roleBindings.map(role => { const item = imageItems.find(item => item.label === `<Picture ${role.pictureRefIndex}>`) ?? {kind:"audio" as const,src:manifest.audioRefs.find(audio => audio.index === role.audioRefIndex)?.storageReference ?? ""}; return { ...item, label: role.subjectAlias, name: role.roleName }; }),
  ];
  return { items, voices: voiceReferenceLabels(manifest), rolePictures:manifest.roleBindings.filter(role => role.pictureRefIndex !== null).length, roleVoices:manifest.roleBindings.filter(role => role.audioRefIndex !== null).length };
}
export async function readMentionItems(spec: MentionSpec): Promise<MentionItem[]> {
  return (await readMentionData(spec)).items;
}
function MentionThumb({ item }: { item: MentionItem }) {
  const url = useImageThumbnail(item.kind === "image" ? item.src : "", 128).url;
  return url ? <img src={url} alt="" decoding="async" draggable={false} /> : <i>{item.kind === "audio" ? "♪" : item.kind === "video" ? "▶" : "▧"}</i>;
}
export function ReferencePromptEditor({ nodeId, textareaRef, value, height, disabled, spec, onChange, onInspect }: {
  nodeId?: string;
  textareaRef: RefObject<HTMLTextAreaElement | null>; value: string; height: number; disabled: boolean;
  spec: MentionSpec | null; onChange: (text: string) => void; onInspect: (item: MentionItem) => void;
}) {
  const [open, setOpen] = useState(false), [query, setQuery] = useState("");
  const [loaded, setLoaded] = useState<{ key: string; items: MentionItem[]; voices?: string[]; rolePictures?: number; roleVoices?: number; error?: string } | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const key = JSON.stringify(spec);
  useEffect(() => {
    const snapshot: MentionSpec | null = JSON.parse(key);
    if (!snapshot) return;
    let active = true;
    void readMentionData(snapshot).then(data => { if (active) setLoaded({ key, ...data }); })
      .catch(cause => { if (active) setLoaded({ key, items: [], error: cause instanceof Error ? cause.message : "引用读取失败" }); });
    return () => { active = false; };
  }, [key]); // snapshot key prevents repeated reads while typing; no asset registration or uploads
  const items = loaded?.key === key ? loaded.items : [];
  const matches = items.filter(item => `${item.label} ${item.name}`.toLowerCase().includes(query.toLowerCase()));
  const labels = referencedLabels(value);
  const used = items.filter(item => labels.some(label => label.toLowerCase() === item.label.toLowerCase()));
  const choose = (item: MentionItem) => {
    if (disabled) return;
    const textarea = textareaRef.current;
    const cursor = textarea?.selectionStart ?? value.length;
    const range = mentionQuery(value, cursor);
    const next = insertMention(value, range?.start ?? cursor, range?.end ?? textarea?.selectionEnd ?? cursor, item.label);
    onChange(next.text); setOpen(false); setQuery("");
    requestAnimationFrame(() => { textarea?.focus(); textarea?.setSelectionRange(next.cursor, next.cursor); });
  };
  const detect = (textarea: HTMLTextAreaElement) => { const match = mentionQuery(textarea.value, textarea.selectionStart); setOpen(!!match && !!spec); setQuery(match?.query ?? ""); setActiveIndex(0); };
  return <div className="reference-prompt-editor" onKeyDown={event => event.stopPropagation()}>
    {spec && spec.roleIds.length > 0 && <small aria-label="角色素材状态" title={loaded?.key === key ? loaded.error ?? "按当前提交绑定统计；不是上传成功标志" : "正在核对"}>{loaded?.key !== key ? "角色素材核对中…" : loaded.error ? `⚠ ${loaded.error}` : `🖼 角色图 ${loaded.rolePictures ?? 0} · 🎙 角色声音 ${loaded.roleVoices ?? 0}`}</small>}
    {spec && (spec.voiceRoleId || spec.voiceRoleIds?.length || spec.dialogue.length > 0) && <div className="h3-preflight" aria-label="角色声音提交检查" role="status">
      {loaded?.key !== key ? <span>正在检查角色主声音…</span> : loaded.error ? <span className="preflight-error">✕ {loaded.error}；本镜头无法提交</span> : loaded.voices?.map(label => <span key={label}>待提交 {label}</span>)}
      {nodeId && <VoiceSubmissionStatus nodeId={nodeId} />}
    </div>}
    {spec && <div className="reference-prompt-tools"><button type="button" disabled={disabled} aria-expanded={open} onMouseDown={event => event.preventDefault()} onClick={() => { setOpen(!open); setQuery(""); setActiveIndex(0); }}>@ 引用素材</button><small>按实际提交顺序编号</small></div>}
    {open && spec && <div className="reference-mention-menu" role="dialog" aria-label="选择提示词引用素材">
      <header><span>选择引用 · ↑↓选择，Enter插入</span><button type="button" aria-label="关闭引用选择" onClick={() => setOpen(false)}>×</button></header>
      {loaded?.key !== key ? <p>正在读取引用…</p> : loaded.error ? <p role="status">{loaded.error}</p> : matches.length ? matches.map((item, index) => <div key={item.label} className={index === activeIndex % matches.length ? "active" : ""}><button type="button" disabled={disabled} onMouseDown={event => event.preventDefault()} onClick={() => choose(item)}><MentionThumb item={item} /><span><b>{item.label}</b><small>{item.name}</small></span></button><button type="button" title={item.nodeId ? "定位画布原素材" : "预览素材"} aria-label={`查看 ${item.label}`} onClick={() => { setOpen(false); onInspect(item); }}>↗</button></div>) : <p>没有匹配素材；先加入参考图或角色。</p>}
    </div>}
    <CopyPromptButton text={value} />
    <label className="prompt-field"><span>提示词</span><textarea ref={textareaRef} style={{ height }} value={value} placeholder="描述画面、动作和声音…" onChange={event => { onChange(event.target.value); detect(event.currentTarget); }} onClick={event => detect(event.currentTarget)} onKeyDown={event => {
      if (!open) return;
      if (event.key === "Escape") { event.preventDefault(); setOpen(false); }
      else if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); setActiveIndex(index => matches.length ? (index + (event.key === "ArrowDown" ? 1 : matches.length - 1)) % matches.length : 0); }
      else if (event.key === "Enter" && !event.nativeEvent.isComposing && matches.length) { event.preventDefault(); choose(matches[activeIndex % matches.length]); }
    }} onBlur={event => { if (!event.relatedTarget || !event.currentTarget.closest('.reference-prompt-editor')?.contains(event.relatedTarget)) setOpen(false); }} /></label>
    {!!used.length && <div className="reference-mention-chips" aria-label="提示词引用的素材">{used.map(item => <button type="button" key={item.label} title={item.name} onClick={() => onInspect(item)}><MentionThumb item={item} /><span>{item.label}</span></button>)}</div>}
  </div>;
}
