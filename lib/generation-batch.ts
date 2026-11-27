import type { RunRecord } from "./production-records.ts";

export const MAX_GENERATION_COUNT = 10;
export function generationSeeds(count: number, fixedSeed?: number, random = Math.random): number[] {
  if (!Number.isInteger(count) || count < 1 || count > MAX_GENERATION_COUNT) throw new Error("生成次数必须为 1～10 次");
  if (fixedSeed !== undefined && (!Number.isSafeInteger(fixedSeed) || fixedSeed < 0)) throw new Error("固定 Seed 必须是非负安全整数");
  const seeds: number[] = [];
  for (let i = 0; i < count; i++) {
    let seed = fixedSeed ?? Math.floor(random() * Number.MAX_SAFE_INTEGER);
    if (fixedSeed === undefined) while (seeds.includes(seed)) seed = (seed + 1) % Number.MAX_SAFE_INTEGER;
    seeds.push(seed);
  }
  return seeds;
}
export async function runSerialGenerations(seeds: readonly number[], signal: AbortSignal, generate: (seed: number, index: number) => Promise<void>) {
  for (let index = 0; index < seeds.length; index++) {
    signal.throwIfAborted();
    await generate(seeds[index], index);
  }
}
/** Clone only immutable input fields; never copy a previous Run's status, output or prompt ID. */
export function candidateRunInput(run: RunRecord, seed: number, batch: { id: string; index: number; count: number }) {
  return structuredClone({ capabilityId: run.capabilityId, inputAssetIds: run.inputAssetIds, rawPrompt: run.rawPrompt, finalPrompt: run.finalPrompt,
    seed, parameters: { ...run.parameters, seed, generationBatch: batch }, workflowIdentity: run.workflowIdentity,
    referenceInputs: run.referenceInputs, shotId: run.shotId, referenceManifest: run.referenceManifest,
    promptMode: run.promptMode, promptCompile: run.promptCompile, ownerNodeId: run.ownerNodeId, taskMode: run.taskMode,
    engine: run.engine, directorContext: run.directorContext, zhengbenVersion: run.zhengbenVersion });
}
