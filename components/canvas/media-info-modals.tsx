"use client";

import { CopyPromptButton } from "@/components/canvas/copy-prompt-button";
import { type H3ReviewSpec, type H3SubmissionReview, inspectH3Submission } from "@/lib/h3-submission-review";
import { voiceReferenceLabels } from "@/lib/voice-reference-status";
import { type AssetRecord, type RunRecord, type ShotRecord, adoptShotAsset, deleteShotCandidate, getAsset, getAssetBySource, getRootCandidateLabel, getRun, getShot, getShotAssetLineage, getShotAssetVersions, getShotCandidates, isH3Capability, restoreShotCandidate } from "@/lib/production-records";
import { hasPromptDialogue } from "@/lib/h3-speaker-policy";
import { workflowOption } from "@/lib/h3-workflow-options";
import { Download, Film, Info, X } from "lucide-react";
import { Editor } from "tldraw";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { announceShotChange, showCanvasToast } from "@/components/canvas/canvas-events";
import { openCanvasTools } from "@/components/canvas/canvas-tools";
import { getRole } from "@/lib/role-records";
import { acquireMediaUrl, releaseMediaUrl } from "@/lib/local-video-store";
import { type ReferenceManifest } from "@/lib/reference-manifest";
import { type H3PromptMode, OFFICIAL_MODE_WARNING } from "@/lib/h3-prompt-compiler";
import { formatFps } from "@/lib/video-fps";
import { H3_TASK_LABELS } from "@/lib/h3-task-mode";
import { describeRunMedia, formatMediaLine } from "@/lib/run-media-map";
import { type H3Node, RUN_MODE_FROM_PARAMETERS, displayVideoAsset, downloadNodeMedia, findShotDisplay, formatElapsed, getLocalImageSize, referenceBlob, shotName, stopPropagation } from "@/components/canvas/workspace-shared";

const capabilityNames: Record<RunRecord["capabilityId"], string> = { cover_generation:"AI短剧封面", h3_fl2va: "H3 视频", h3_ref2va: "H3 多参考", h3_addguide_experimental: "H3 🧪引导锚点", h3_ultimate_guide: "H3 🧪时间锚点", seedvr2_upscale: "高清增强", final_cut_rough: "粗剪成片", film_interpolation: "流畅增强", music_removal: "去配乐" };
const runStatusNames: Record<RunRecord["status"], string> = { queued: "排队中", running: "生成中", completed: "已完成", failed: "失败", cancelled: "已取消" };

function CandidateThumbnail() {
  return <span className="shot-candidate-thumb"><Film size={17} /></span>;
}
export function ShotCandidatesPanel({ shotId, editor, onClose }: { shotId: string; editor: Editor; onClose: () => void }) {
  const [showDeleted, setShowDeleted] = useState(false);
  const [shot, setShot] = useState<ShotRecord | null>(null);
  const [versions, setVersions] = useState<AssetRecord[]>([]);
  const [labels, setLabels] = useState<Record<string, string>>({});
  const [lineages, setLineages] = useState<Record<string, string>>({});
  const [selectedId, setSelectedId] = useState("");
  const [previewUrl, setPreviewUrl] = useState("");
  const [error, setError] = useState("");
  const [working, setWorking] = useState(false);
  const [infoAssetId, setInfoAssetId] = useState("");
  useEffect(() => { let active = true; const refresh = async () => {
    const [nextShot, nextVersions, candidates] = await Promise.all([getShot(shotId), getShotAssetVersions(shotId, true), getShotCandidates(shotId)]);
    const names: Record<string, string> = {}; const paths: Record<string, string> = {};
    for (const asset of nextVersions) { names[asset.assetId] = await getRootCandidateLabel(shotId, asset.assetId) ?? "—"; paths[asset.assetId] = await getShotAssetLineage(shotId, asset.assetId) ?? ""; }
    if (active) { setShot(nextShot); setVersions(nextVersions); setLabels(names); setLineages(paths); setSelectedId((current) => current || nextShot?.adoptedAssetId || candidates.at(-1)?.asset.assetId || nextVersions.at(-1)?.assetId || ""); }
  }; void refresh().catch((cause) => { if (active) setError(cause instanceof Error ? cause.message : "候选结果读取失败"); }); window.addEventListener("frameflow-shot-changed", refresh); return () => { active = false; window.removeEventListener("frameflow-shot-changed", refresh); }; }, [shotId]);
  const visibleVersions = versions.filter(asset => Boolean(shot?.deletedCandidateAssetIds?.includes(asset.assetId)) === showDeleted);
  const selected = visibleVersions.find((asset) => asset.assetId === selectedId) ?? visibleVersions.find(asset => asset.assetId === shot?.adoptedAssetId) ?? visibleVersions.at(-1);
  const activePreviewId = selected?.assetId ?? '';
  useEffect(() => { let active = true; let owned = ""; let releaseKey: string | null = null; queueMicrotask(() => { if (active) setPreviewUrl(""); }); const selected = versions.find((asset) => asset.assetId === activePreviewId); if (selected) void acquireMediaUrl(selected.storageReference).then((result) => { if (!active) { releaseMediaUrl(result.key); if (result.revoke) URL.revokeObjectURL(result.url); return; } releaseKey = result.key; if (result.revoke) owned = result.url; setPreviewUrl(result.url); }).catch(() => { if (active) setError("候选视频无法读取"); }); return () => { active = false; releaseMediaUrl(releaseKey); if (owned) URL.revokeObjectURL(owned); }; }, [activePreviewId, versions]);
  useEffect(() => { const key = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); }; window.addEventListener("keydown", key); return () => window.removeEventListener("keydown", key); }, [onClose]);
  const changeDeleted = async () => {
    if (!selected || working) return;
    setWorking(true); setError('');
    try {
      const next = showDeleted ? await restoreShotCandidate(shotId, selected.assetId) : await deleteShotCandidate(shotId, selected.assetId);
      setShot(next); setSelectedId('');
      announceShotChange(shotId);
      showCanvasToast(showDeleted ? '候选已恢复' : '候选已删除，可在“已删除”中恢复；原文件保留');
    } catch(cause) { setError(cause instanceof Error ? cause.message : '候选操作失败'); }
    finally { setWorking(false); }
  };
  const adopt = async () => { if (!selected || working) return; setWorking(true); setError(""); try {
    const changed = await adoptShotAsset(shotId, selected.assetId);
    editor.run(() => {
      for (const node of editor.getCurrentPageShapes()) {
        if (node.type === 'h3-node' && (node as H3Node).props.shotId === shotId) editor.updateShape({id:node.id,type:'h3-node',props:{previewAssetId:selected.assetId}});
      }
    });
    const primary = findShotDisplay(editor, shotId);
    if (primary) displayVideoAsset(editor, primary, selected);
    setShot(changed); announceShotChange(shotId); showCanvasToast(`${shotName(changed)}已采用${lineages[selected.assetId] || `候选 ${labels[selected.assetId] ?? "—"}`}`);
  } catch (cause) { setError(cause instanceof Error ? cause.message : "采用失败"); } finally { setWorking(false); } };
  return <div className="generation-info-backdrop" onPointerDown={(event) => { event.stopPropagation(); if (event.target === event.currentTarget) onClose(); }} onClick={stopPropagation} onContextMenu={stopPropagation}>
    <section className="generation-info-panel shot-candidates-panel" role="dialog" aria-modal="true" aria-label="镜头候选结果" onPointerDown={stopPropagation}>
      <header><div><small>{shot ? shotName(shot) : "镜头"}</small><h2>候选结果</h2></div><button type="button" aria-label="关闭候选结果" onClick={onClose}><X size={17} /></button></header>
      <div className="shot-candidate-actions" style={{padding:'12px 20px'}}><button type="button" disabled={working} aria-pressed={!showDeleted} onClick={()=>{setShowDeleted(false);setSelectedId('');}}>候选结果</button><button type="button" disabled={working} aria-pressed={showDeleted} onClick={()=>{setShowDeleted(true);setSelectedId('');}}>已删除（{shot?.deletedCandidateAssetIds?.length ?? 0}）</button><button type="button" disabled={showDeleted} onClick={()=>openCanvasTools("compare",visibleVersions.map(a=>a.assetId))}>并排同步对比</button>{selected&&!showDeleted&&<button type="button" onClick={()=>openCanvasTools("promote",[selected.assetId])}>此试片转正</button>}<small>删除可恢复，原文件和已有引用保留。</small></div>
      <div className="shot-candidates-body">
        {visibleVersions.length ? <div className="shot-candidate-list">{visibleVersions.map((asset) => <button type="button" key={asset.assetId} className={selectedId === asset.assetId ? "active" : ""} onClick={() => setSelectedId(asset.assetId)}><CandidateThumbnail /><span className="shot-candidate-copy"><b>{lineages[asset.assetId] || `候选 ${labels[asset.assetId]}`}{shot?.adoptedAssetId === asset.assetId ? " · ★ 已采用" : ""}</b><small title={asset.filename}>{asset.filename}</small><small>{new Date(asset.createdAt).toLocaleString("zh-CN")} · {asset.duration ? `${asset.duration.toFixed(1)}秒` : "时长未记录"}{asset.width && asset.height ? ` · ${asset.width}×${asset.height}` : ""}{asset.fps ? ` · ${formatFps(asset.fps)} FPS` : ""}</small></span></button>)}</div> : <p>{showDeleted ? "没有已删除候选。" : "没有可用候选。失败任务仍保留在生成记录中。"}</p>}
        {selected && <div className="shot-candidate-detail">{previewUrl ? <video key={selected.assetId} src={previewUrl} controls playsInline preload="metadata" onPointerDown={stopPropagation} onClick={stopPropagation} /> : <p>正在读取视频…</p>}<p>{lineages[selected.assetId] || `候选 ${labels[selected.assetId] ?? "—"}`} · {selected.filename}</p><div className="shot-candidate-actions"><button type="button" disabled={working || showDeleted || shot?.adoptedAssetId === selected.assetId} onClick={() => void adopt()}>{shot?.adoptedAssetId === selected.assetId ? "★ 已采用" : "☆ 采用此版本"}</button><button type="button" onClick={() => setInfoAssetId(selected.assetId)}><Info size={14} />生成信息</button><button type="button" onClick={() => downloadNodeMedia(selected.storageReference, selected.filename, "video")}><Download size={14} />下载</button><button type="button" disabled={working || (!showDeleted && shot?.adoptedAssetId === selected.assetId)} title={shot?.adoptedAssetId === selected.assetId ? "先采用其他候选再删除" : showDeleted ? "恢复此候选" : "移到已删除，保留原文件"} onClick={() => void changeDeleted()}><X size={14} />{showDeleted ? "恢复候选" : "删除候选"}</button></div></div>}
        {error && <p className="shot-candidate-error">{error}</p>}
      </div>
    </section>
    {infoAssetId && createPortal(<GenerationInfo runId={versions.find((asset) => asset.assetId === infoAssetId)?.sourceRunId ?? undefined} assetId={infoAssetId} fallbackName={versions.find((asset) => asset.assetId === infoAssetId)?.filename ?? "视频"} onClose={() => setInfoAssetId("")} />, document.body)}
  </div>;
}
const pictureSourceNames: Record<string, string> = { first_frame: "首帧", connected_reference: "已连接参考图", reference_image: "参考图", role_appearance: "角色主外观" };
export function ManifestInfo({ manifest, promptMode, notes, planned = false }: { manifest: ReferenceManifest; promptMode: H3PromptMode; notes: string[]; planned?: boolean }) {
  const roleName = (roleId: string) => manifest.roleBindings.find((binding) => binding.roleId === roleId)?.roleName ?? "—";
  const picture = (index: number | null) => index === null ? undefined : manifest.pictureRefs[index - 1];
  const audio = (index: number) => manifest.audioRefs[index - 1];
  return <>
    <dt>Prompt 模式</dt><dd>{promptMode === "official_structured" ? <><b className="experimental-note">🧪 官方结构 Prompt｜尚待本机真人验证</b>{notes.filter((note) => note !== OFFICIAL_MODE_WARNING).map((note) => <div key={note} className="muted-id">{note}</div>)}</> : <>普通 Prompt{notes.length ? notes.map((note) => <div key={note} className="muted-id">{note}</div>) : "（原样提交）"}</>}</dd>
    <dt>参考绑定</dt><dd>{manifest.roleBindings.length ? manifest.roleBindings.map((binding) => <div key={binding.roleId} className="manifest-binding"><b>{binding.roleName}</b><div>{binding.offscreen ? "画外音角色 · 不提交主外观图" : <>主外观：{picture(binding.pictureRefIndex)?.filename ?? "—"} · Picture {binding.pictureRefIndex}</>}</div><div>{binding.audioRefIndex ? <>{binding.voiceSource === "role_primary" || manifest.voiceRoleId === binding.roleId ? "主声音" : "参考声音"}：{audio(binding.audioRefIndex)?.filename ?? "—"} · Audio {binding.audioRefIndex}</> : planned ? "本次不携带角色声音" : "本次未提交角色声音"}</div></div>) : "未选择角色"}</dd>
    <dt>Subject</dt><dd>{manifest.roleBindings.length ? manifest.roleBindings.map((binding) => <div key={binding.roleId}>{binding.subjectAlias} = {binding.roleName}</div>) : "—"}</dd>
    <dt>Speaker</dt><dd>{manifest.speakers.length ? manifest.speakers.map((speaker) => <div key={speaker.speakerId}>{speaker.speakerId} = {roleName(speaker.roleId)}（&lt;Subject {speaker.subjectIndex}&gt;）{speaker.audioRefIndex ? ` · Audio ${speaker.audioRefIndex}` : ""}</div>) : manifest.dialogue.length ? "无绑定角色说话者（见逐句台词核对）" : "无台词，无 Speaker"}</dd>
    {manifest.dialogue.length>0 && <><dt>逐句台词核对</dt><dd>{manifest.dialogue.map(line=>{const binding=manifest.roleBindings.find(role=>role.roleId===line.roleId);const index=line.roleId?binding?.audioRefIndex:line.audioRefIndex;return <div key={line.order}>{line.order}. {binding?.roleName??line.speaker} · {index ? `${line.roleId?'角色主声音':'声音素材'} · Audio ${index} · ${manifest.audioRefs.find(audio=>audio.index===index)?.filename??'缺少声音'}` : '无（不带角色声音）'}<div>{line.text}</div></div>;})}</dd></>}
    <dt>Picture / Audio 编号</dt><dd>
      {manifest.pictureRefs.map((ref) => <div key={ref.label} title={ref.filename}>Picture {ref.index} · {ref.filename} · {ref.sources.map((source) => pictureSourceNames[source] ?? source).join("、")}{ref.roleIds.length ? ` · ${ref.roleIds.map(roleName).join("、")}` : ""}</div>)}
      {manifest.videoRefs.map((ref) => <div key={ref.label} title={ref.filename}>Video {ref.index} · {ref.filename}{ref.audioIndex ? ` · 原声为 Audio ${ref.audioIndex}` : ""}</div>)}
      {manifest.audioRefs.map((ref) => <div key={ref.label} title={ref.filename}>Audio {ref.index} · {ref.filename} · {ref.kind === "video_soundtrack" ? `Video ${ref.videoIndex} 的原声` : ref.roleIds.length ? `${ref.roleIds.map(roleName).join("、")} 的声音` : "参考声音"}</div>)}
    </dd>
    <dt>Manifest</dt><dd><details className="manifest-json"><summary>完整 Manifest（高级）</summary><pre>{JSON.stringify(manifest, null, 2)}</pre></details></dd>
  </>;
}
export function H3SubmissionInfo({ spec, zhengbenVersion, onClose }: { spec: H3ReviewSpec; zhengbenVersion?: string; onClose: () => void }) {
  const [loaded, setLoaded] = useState<{ key: string; revision: number; review: H3SubmissionReview } | null>(null);
  const [revision, setRevision] = useState(0);
  const key = JSON.stringify(spec);
  const roleWatchKey=JSON.stringify([...new Set([...spec.roleIds,...(spec.voiceRoleId?[spec.voiceRoleId]:[]),...(spec.voiceRoleIds??[]),...(spec.offscreenRoleIds??[]),...spec.dialogue.map(d=>d.roleId)])]);
  useEffect(()=>{
    let live=true,reading=false,last="";
    const refresh=()=>setRevision(value=>value+1);
    const check=async()=>{if(!live||document.hidden||reading)return;reading=true;try{const roles=await Promise.all((JSON.parse(roleWatchKey) as string[]).map(getRole));const fingerprint=JSON.stringify(roles);if(live&&last&&fingerprint!==last)refresh();last=fingerprint;}catch{/* Explicit refresh reports errors through the normal read path. */}finally{reading=false;}};
    void check();const timer=setInterval(()=>void check(),5000);
    const onVisibility=()=>{if(!document.hidden){void check();refresh();}};
    document.addEventListener("visibilitychange",onVisibility);
    window.addEventListener("focus",refresh);
    return()=>{live=false;clearInterval(timer);window.removeEventListener("focus",refresh);document.removeEventListener("visibilitychange",onVisibility);};
  },[roleWatchKey]);
  useEffect(() => {
    let active = true;
    const snapshot: H3ReviewSpec = JSON.parse(key);
    void inspectH3Submission(snapshot, {
      assetBySource: getAssetBySource, asset: getAsset, role: getRole,
      imageSize: async src => getLocalImageSize(src),
      checkMedia: async (src, kind, name) => { const blob = await referenceBlob(src, kind, name); if (!blob.size) throw new Error("空素材"); },
    }).then(review => { if (active) setLoaded({ key, revision, review }); })
      .catch(cause => { if (active) setLoaded({ key, revision, review: { errors: [cause instanceof Error ? cause.message : "无法读取核对信息"], warnings: [], inputs: [], notes: [], mode: snapshot.mode } }); });
    return () => { active = false; };
  }, [key, revision]);
  useEffect(() => { const escape = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); }; window.addEventListener("keydown", escape); return () => window.removeEventListener("keydown", escape); }, [onClose]);
  const review = loaded?.key === key && loaded.revision === revision ? loaded.review : null;
  const parameters = review?.parameters;
  const voices = voiceReferenceLabels(review?.manifest);
  const display = (value: unknown) => value === undefined || value === null ? "—" : String(value);
  return <div className="generation-info-backdrop" onPointerDown={event => { event.stopPropagation(); if (event.target === event.currentTarget) onClose(); }} onClick={stopPropagation} onContextMenu={stopPropagation}>
    <section className="generation-info-panel h3-submission-info-panel" role="dialog" aria-modal="true" aria-label="生成信息 · 提交前核对" onPointerDown={stopPropagation}>
      <header><div><small className="ff-hint">当前节点 · 待提交核对 · 随设置自动更新</small><h2>生成信息</h2></div><div style={{display:"flex",gap:12,alignItems:"center"}}><button type="button" aria-label="刷新生成信息" style={{width:"auto",minWidth:88,height:34,padding:"0 12px",background:"var(--ff-hover)",border:"1px solid var(--ff-text-3)",whiteSpace:"nowrap"}} onClick={()=>setRevision(value=>value+1)}>刷新核对</button><button type="button" aria-label="关闭生成信息" onClick={onClose}><X size={17} /></button></div></header>
      <p className="ff-hint">以下是按当前设置整理的待提交内容，不代表已经提交。已生成视频的实际记录请在“查看全部 → 生成信息”查看。</p>
      <p className="ff-hint muted-id">刷新只重新读取并核对，不会生成视频，也不会自动添加声音。若已锁定上次角色绑定，刷新仍保留该快照。</p>
      {!review ? <p role="status">正在核对编号、角色声音和本地素材…</p> : <>
        <div className="h3-submission-checks" role="status">{review.errors.length ? "有缺失或冲突，请修正后再生成" : "本地核对通过 · 尚未上传 / 提交"}
          {review.errors.map(message => <p className="preflight-error" key={message}>✕ {message}</p>)}
          {review.warnings.map((message,index) => <p key={index}>△ {message}</p>)}
        </div>
        <dl>
          <dt>正本版本</dt><dd>{zhengbenVersion ? `正本 ${zhengbenVersion}（入队时读的）` : "提交时读正本开头的「正本 v…」写进记录；读不到记「未知」"}</dd>
          <dt>工作流 / 模式</dt><dd>{workflowOption(spec.workflowOptionId)?.label ?? "未知工作流"} · {review.mode ? H3_TASK_LABELS[review.mode] : "待确定"}</dd>
          <dt>像素预算 / 比例</dt><dd>{Number(parameters?.megapixels ?? spec.settings.megapixels).toFixed(2)} MP · {display(parameters?.aspectRatio ?? spec.settings.aspect)}{!parameters && "（当前设置；编译未完成）"}</dd>
          <dt>输出尺寸</dt><dd>{typeof parameters?.width === "number" && typeof parameters?.height === "number" ? `${parameters.width} × ${parameters.height}（工作流提交尺寸）` : parameters ? "精确尺寸由 ComfyUI 按像素预算和比例计算，输出后记录" : "尚未确定，请先解决上方问题"}</dd>
          <dt>时长 / 帧率</dt><dd>{display(parameters?.duration ?? spec.settings.length / spec.settings.fps)} 秒 · {display(parameters?.fps ?? spec.settings.fps)} FPS · {spec.settings.length} 帧{spec.extension && "（新增段；输出还包含原片）"}</dd>
          <dt>声音模式</dt><dd>{spec.settings.soundMode ?? "av"} · {spec.settings.noBackgroundMusic ? "禁止背景音乐（提示词约束）" : "未设置禁止背景音乐"}</dd>
          <dt>角色主声音</dt><dd>{voices.length ? voices.map(label => <div key={label}>待提交 {label}</div>) : review.manifest || !spec.referenceMode ? <>{spec.autoVoiceDisabled ? "本节点已手动关闭角色主声音。" : spec.dialogue.length ? "逐句声音已按 dialogue 配置，见下方核对；无角色说话者不套用主角色声音。" : hasPromptDialogue(spec.prompt) ? "检测到台词：未能确认主声音，请处理上方错误后提交。" : "无对白镜头无需添加角色主声音。"}{spec.roleIds.length>0&&!spec.dialogue.length&&<div className="preflight-warning">自动模式根据台词选择首个角色；请确认角色库已绑定主声音。可在“角色／更多”手动指定或明确关闭。</div>}</> : "尚未确认，请查看上方缺失提示"}</dd>
          <dt>实际输入顺序</dt><dd>{review.inputs.length ? review.inputs.map((item,index) => <div key={index}>{item.label} · {item.name}</div>) : "无参考素材（文生视频可为空）"}</dd>
          {review.manifest && <ManifestInfo manifest={review.manifest} promptMode={review.promptMode ?? "plain"} notes={review.notes} planned />}
          <dt>原始提示词</dt><dd className="prompt-copy"><CopyPromptButton text={spec.prompt} />{spec.prompt || "未填写"}</dd>
          <dt>最终待提交提示词</dt><dd className="prompt-copy"><CopyPromptButton text={review.finalPrompt ?? ""} />{review.finalPrompt ?? "未能编译，请先修正缺失项"}</dd>
          <dt>Seed</dt><dd>{spec.seed === undefined ? "生成时随机确定" : display(spec.seed)}</dd>
          <dt>Steps</dt><dd>{display(parameters?.steps)}</dd>
          <dt>模板</dt><dd>{review.workflow ?? "尚未完成编译"}</dd>
        </dl>
        <p className="ff-hint">这里只检查当前素材可读性及提交结构；不检查服务在线、模型安装，也不保证实际音色或渲染效果。</p>
      </>}
    </section>
  </div>;
}

export function GenerationInfo({ runId, assetId, fallbackName, onClose }: { runId?: string; assetId?: string; fallbackName: string; onClose: () => void }) {
  const [run, setRun] = useState<RunRecord | null>(null);
  const [assets, setAssets] = useState<AssetRecord[]>([]);
  const [outputAsset, setOutputAsset] = useState<AssetRecord | null>(null);
  const [loading, setLoading] = useState(true);
  const [shotDetail, setShotDetail] = useState<{ shot: ShotRecord; label: string | null; lineage: string | null } | null>(null);
  useEffect(() => { let active = true; void (async () => {
    const result = runId ? await getRun(runId) : null;
    const inputs = result ? await Promise.all(result.inputAssetIds.map((id) => getAsset(id))) : [];
    const output = assetId ? await getAsset(assetId) : null;
    const relatedShotId = output?.shotId ?? result?.shotId;
    const relatedShot = relatedShotId ? await getShot(relatedShotId) : null;
    const label = relatedShot && output ? await getRootCandidateLabel(relatedShot.shotId, output.assetId) : null;
    const lineage = relatedShot && output ? await getShotAssetLineage(relatedShot.shotId, output.assetId) : null;
    if (active) { setRun(result); setAssets(inputs.filter((item): item is AssetRecord => Boolean(item))); setOutputAsset(output); setShotDetail(relatedShot ? { shot: relatedShot, label, lineage } : null); setLoading(false); }
  })().catch((cause) => { if (active) { setLoading(false); showCanvasToast(cause instanceof Error ? cause.message : "无法读取生成信息"); } });
    return () => { active = false; };
  }, [runId, assetId]);
  useEffect(() => { const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); }; window.addEventListener("keydown", onKey); return () => window.removeEventListener("keydown", onKey); }, [onClose]);
  const detail = (value: unknown) => value === null || value === undefined || value === "" ? "—" : String(value);
  const isH3Run = isH3Capability(run?.capabilityId);
  const runTaskMode = run ? run.taskMode ?? RUN_MODE_FROM_PARAMETERS[String(run.parameters.mode)] : undefined;
  const media = run && isH3Run ? describeRunMedia(run, new Map(assets.map((asset) => [asset.assetId, asset.filename]))) : null;
  return <div className="generation-info-backdrop" onPointerDown={(event) => { event.stopPropagation(); if (event.target === event.currentTarget) onClose(); }} onClick={stopPropagation} onContextMenu={stopPropagation}>
    <section className="generation-info-panel" role="dialog" aria-modal="true" aria-label="生成信息" onPointerDown={stopPropagation}>
      <header><div><small>只读记录</small><h2>生成信息</h2></div><button type="button" aria-label="关闭生成信息" onClick={onClose}><X size={17} /></button></header>
      {loading ? <p>正在读取记录…</p> : !run ? <div className="generation-info-legacy"><strong>旧版结果｜无完整生成记录</strong><p>{fallbackName}</p><p>旧结果没有保存真实 Prompt、Seed 和 Workflow，系统不会猜测或补造。</p>{outputAsset && <p>{outputAsset.width && outputAsset.height ? `${outputAsset.width}×${outputAsset.height}` : ""}{outputAsset.fps ? ` · ${formatFps(outputAsset.fps)} FPS` : ""}{outputAsset.duration ? ` · ${outputAsset.duration.toFixed(1)} 秒` : ""}</p>}</div> : <dl>
        <dt>能力</dt><dd>{capabilityNames[run.capabilityId]}</dd>
        <dt>生成时间</dt><dd>{new Date(run.createdAt).toLocaleString("zh-CN")}</dd>
        <dt>排队 / 执行</dt><dd>{run.startedAt ? `等待/准备 ${formatElapsed(Math.max(0,Math.round(((run.completedAt??run.startedAt)-run.createdAt-(run.executionTiming?.executionMs??((run.completedAt??run.startedAt)-run.startedAt)))/1000)))} · 执行 ${run.completedAt?formatElapsed(Math.max(0,Math.round((run.executionTiming?.executionMs??(run.completedAt-run.startedAt))/1000))):"进行中"}` : "未记录真实开始时间"}</dd>
        {run.executionTiming&&<><dt>阶段耗时（观察值）</dt><dd>{Object.entries(run.executionTiming.stages).map(([key,ms])=><div key={key}>{key}：{formatElapsed(Math.round(ms/1000))}</div>)}<small className="ff-hint">按实时执行事件统计，含准备/加载、采样、解码/保存；非GPU分析器数据，断线期间不补造阶段时间。</small></dd></>}
        <dt>状态</dt><dd>{runStatusNames[run.status]} · {run.submission === "accepted" && run.comfyPromptId ? "ComfyUI 已确认接收" : "尚无 ComfyUI 接收确认"}</dd>
        {run.musicRemoval && <><dt>去配乐</dt><dd>{run.musicRemoval.status === "skipped" ? "节点认出已处理过，跳过（没有新文件）" : run.musicRemoval.status === "running" ? "进行中" : (run.musicRemoval.totalPasses ?? 1) > 1 ? `第 ${run.musicRemoval.totalPasses} 遍（再去一次，结果是去配乐 ×${run.musicRemoval.totalPasses}）` : "第 1 遍"}{(run.musicRemoval.passes ?? []).map((item) => <div key={item.pass} className="muted-id">第 {item.pass} 遍：输入 {item.input || "—"} → 输出 {item.output ?? "（未完成）"}{item.device ? ` · ${item.device}` : ""}{item.seconds !== undefined ? ` · ${item.seconds} 秒` : ""}</div>)}</dd></>}
        {isH3Run && <><dt>生成模式</dt><dd>{runTaskMode ? H3_TASK_LABELS[runTaskMode] : "—"}</dd>
        <dt>生成映射</dt><dd className="media-map">{media && media.lines.length ? media.lines.map((line, index) => <div key={index}>{formatMediaLine(line)}</div>) : media?.note ?? "—"}{media?.note && media.lines.length ? <div className="muted-id">{media.note}</div> : null}</dd>
        {!run.referenceManifest && <><dt>Prompt 模式</dt><dd>{run.promptMode === "official_structured" ? "🧪 官方结构（按 Reference Manifest 编译）" : "普通（原样提交）"}</dd></>}
        <dt>正本版本</dt><dd>{run.zhengbenVersion ? `正本 ${run.zhengbenVersion}${run.zhengbenVersion === "未知" ? "（提交时没读到 SKILL_h3-video.md 开头的「正本 v…」）" : ""}` : "未记录（此记录早于正本版本号功能）"}</dd>
        <dt>引擎</dt><dd>{run.engine ? <>ComfyUI {run.engine.comfyuiVersion ?? "版本未知"}{run.engine.pytorchVersion ? ` · PyTorch ${run.engine.pytorchVersion}` : ""}{[...new Map(run.engine.nodes.map((node) => [node.pack ?? node.classType, node])).values()].map((node) => <div key={node.pack ?? node.classType} className="muted-id">{node.pack === "ComfyUI core" ? `ComfyUI 内置节点 · ${node.version ?? "版本未知"}` : node.pack ? `${node.pack} · ${node.version ?? "版本号未提供（手动安装的节点包）"}` : `${node.classType} · ComfyUI 中未找到`}</div>)}{run.engine.note && <div className="muted-id">{run.engine.note}</div>}</> : "未记录（此记录早于版本记录功能）"}</dd></>}
        {shotDetail && <><dt>镜头</dt><dd>{shotName(shotDetail.shot)} · 候选 {shotDetail.label ?? "—"}</dd><dt>采用状态</dt><dd>{shotDetail.shot.adoptedAssetId === outputAsset?.assetId ? "★ 已采用" : "未采用"}</dd><dt>来源</dt><dd>{shotDetail.lineage ?? "H3 原始版本"}</dd></>}
        <dt>输入素材</dt><dd>{assets.length ? assets.map((asset) => <div key={asset.assetId} title={asset.filename}>{asset.kind === "image" ? "图片" : asset.kind === "audio" ? "音频" : "视频"} · {asset.filename}</div>) : "—"}</dd>
        {run.capabilityId === "h3_ref2va" && (run.referenceManifest ? <ManifestInfo manifest={run.referenceManifest} promptMode={run.promptMode ?? "plain"} notes={run.promptCompile?.notes ?? []} /> : <><dt>参考绑定</dt><dd className="muted-id">旧版本生成记录，无 Reference Manifest</dd></>)}
        {run.rawPrompt !== null && <><dt>原始 Prompt</dt><dd className="prompt-copy"><CopyPromptButton text={run.rawPrompt} />{run.rawPrompt}</dd><dt>最终提交 Prompt</dt><dd className="prompt-copy"><CopyPromptButton text={run.finalPrompt ?? ""} />{detail(run.finalPrompt)}</dd></>}
        {run.seed !== null && <><dt>Seed</dt><dd>{run.seed}</dd></>}
        {run.parameters.steps !== undefined && <><dt>实际 Steps</dt><dd>{detail(run.parameters.steps)}</dd></>}
        <dt>尺寸</dt><dd>{run.parameters.width && run.parameters.height ? `${run.parameters.width}×${run.parameters.height}` : outputAsset?.width && outputAsset.height ? `${outputAsset.width}×${outputAsset.height}` : "未记录"}</dd>
        {isH3Run && <><dt>像素预算 / 比例</dt><dd>{typeof run.parameters.megapixels === "number" ? `${run.parameters.megapixels.toFixed(2)} MP` : "未记录"} · {detail(run.parameters.aspectRatio)}</dd></>}
        <dt>FPS</dt><dd>{detail(run.parameters.fps ?? run.parameters.outputFps ?? outputAsset?.fps)}</dd>
        <dt>Workflow</dt><dd title={run.workflowIdentity.templateVersion}>{run.workflowIdentity.templateFile} · {run.workflowIdentity.templateVersion.slice(0, 20)}…</dd>
        <dt>Run ID</dt><dd className="muted-id" title={run.runId}>{run.runId}</dd>
        {run.error && <><dt>错误</dt><dd>{run.error}</dd></>}
      </dl>}
    </section>
  </div>;
}
