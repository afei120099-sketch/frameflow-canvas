import type { ReferenceManifest } from "./reference-manifest.ts";
import type { RunRecord } from "./production-records.ts";

export function voiceReferenceLabels(manifest?: ReferenceManifest) {
  return (manifest?.roleBindings ?? []).flatMap(role => {
    const audio = manifest!.audioRefs.find(ref => ref.kind === "standalone" && ref.index === role.audioRefIndex && ref.assetId === role.selectedVoiceAssetId);
    return audio ? [`${role.roleName} ${role.voiceSource === "role_primary" || manifest!.voiceRoleId === role.roleId ? "主声音" : "参考声音"} · Audio ${audio.index}`] : [];
  });
}

/** A reserved prompt ID is not proof of submission. Always inspect the latest task. */
export function submittedVoiceLabels(nodeId: string, runs: readonly RunRecord[]) {
  const latest = runs.filter(run => run.ownerNodeId === nodeId).sort((a, b) => b.createdAt - a.createdAt)[0];
  return latest?.submission === "accepted" && latest.comfyPromptId ? voiceReferenceLabels(latest.referenceManifest) : [];
}
