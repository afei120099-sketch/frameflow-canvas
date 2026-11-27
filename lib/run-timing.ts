/** Persisted execution start is the boundary: queue time must never count as generation. */
export function runTiming(run: {createdAt:number;startedAt:number|null;completedAt:number|null;executionTiming?:{executionMs?:number}}, now:number) {
  const end = run.completedAt ?? now;
  const seconds = (ms:number) => Math.max(0,Math.floor(ms/1000));
  return {
    queueSeconds: run.executionTiming?.executionMs!==undefined ? seconds(end-run.createdAt-run.executionTiming.executionMs) : seconds((run.startedAt ?? end)-run.createdAt),
    generationSeconds: run.startedAt === null ? null : seconds(run.executionTiming?.executionMs ?? (end-run.startedAt)),
  };
}
