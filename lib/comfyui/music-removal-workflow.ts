/**
 * 去配乐（CDX23）: the ComfyUI graph for our own node `FrameflowDemixVideo` (custom_nodes\Frameflow-Demix).
 * See docs/去配乐-ComfyUI节点.md §2–§3. The node copies the picture stream untouched and replaces the audio
 * with dialogue + effects. It never touches the original file.
 */
import type { MediaGraph } from "./media-workflow-job.ts";

export const MUSIC_REMOVAL_LOAD_NODE = "1";
export const MUSIC_REMOVAL_SAVE_NODE = "2";
export const MUSIC_REMOVAL_MODEL = "CDX23";
export const MUSIC_REMOVAL_TEMPLATE_FILE = "music-removal-workflow.ts";

export interface MusicRemovalSettings {
  /** high = 3 CDX23 models averaged (the version the user listened to); fast = 1 model. */
  quality: "high" | "fast";
  device: "auto" | "cuda" | "cpu";
  /** −120 = music fully removed. */
  musicGainDb: number;
  ifAlreadyDemixed: "skip" | "run_again";
}
export const DEFAULT_MUSIC_REMOVAL: MusicRemovalSettings = { quality: "high", device: "auto", musicGainDb: -120, ifAlreadyDemixed: "skip" };

/** `source_tag` carries the original asset id; the node writes it into the output file and the job result. */
export function buildMusicRemovalWorkflow(inputFile: string, sourceAssetId: string, settings: MusicRemovalSettings = DEFAULT_MUSIC_REMOVAL): MediaGraph {
  return {
    [MUSIC_REMOVAL_LOAD_NODE]: { class_type: "LoadVideo", inputs: { file: inputFile } },
    [MUSIC_REMOVAL_SAVE_NODE]: {
      class_type: "FrameflowDemixVideo",
      inputs: {
        video: [MUSIC_REMOVAL_LOAD_NODE, 0],
        quality: settings.quality,
        device: settings.device,
        music_gain_db: settings.musicGainDb,
        filename_prefix: `video/Frameflow_Demix_${sourceAssetId.replace(/[^a-zA-Z0-9]/g, "").slice(0, 8) || "video"}`,
        source_tag: sourceAssetId,
        if_already_demixed: settings.ifAlreadyDemixed,
      },
    },
  };
}

/** `ui.frameflow_demix[0]` as written by the node. */
export interface DemixResultInfo {
  status: "done" | "skipped";
  source_tag?: string;
  source_file?: string;
  quality?: string;
  music_gain_db?: number;
  output?: string;
  subfolder?: string;
  /** e.g. "cuda（可用 14.8 GB）" or "cpu". */
  device?: string;
  seconds?: number;
  created?: string;
  reason?: string;
  previous?: unknown;
}
type SavedFile = { filename: string; subfolder?: string; type?: string };
export type DemixNodeOutput = { images?: SavedFile[]; videos?: SavedFile[]; frameflow_demix?: unknown[] } | undefined;

/**
 * Read one history output. `null` = not finished yet. A "skipped" result has no mp4 and is NOT a failure.
 */
export function readDemixOutput(output: DemixNodeOutput): { kind: "done"; file: SavedFile; info: DemixResultInfo } | { kind: "skipped"; info: DemixResultInfo } | null {
  const raw = output?.frameflow_demix?.[0];
  const info = raw && typeof raw === "object" ? raw as DemixResultInfo : null;
  if (info?.status === "skipped") return { kind: "skipped", info };
  const file = [...(output?.videos ?? []), ...(output?.images ?? [])].find((item) => /\.mp4$/i.test(item?.filename ?? ""));
  if (file) return { kind: "done", file, info: info ?? { status: "done" } };
  return null;
}

/** Short Chinese device label for the Run record and the node. */
export function demixDeviceLabel(device: string | undefined) {
  if (!device) return "未知";
  return /^cuda/i.test(device) ? `显卡（${device}）` : /^cpu/i.test(device) ? `CPU（${device}）` : device;
}

/** Rough time for the confirm dialog: measured 2.8 s (GPU) and 22.3 s (CPU) for a 5.9 s clip, plus upload/save. */
export function estimateMusicRemovalSeconds(durations: number[]) {
  const total = durations.reduce((sum, value) => sum + (Number.isFinite(value) && value > 0 ? value : 10), 0);
  const overhead = durations.length * 3;
  return { gpu: Math.round(total * 0.5 + overhead), cpu: Math.round(total * 3.8 + overhead) };
}
