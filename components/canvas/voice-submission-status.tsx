"use client";
import { useEffect, useState } from "react";
import { submittedVoiceLabels } from "@/lib/voice-reference-status";
import { nodeRuns } from './run-observer';

export function VoiceSubmissionStatus({ nodeId }: { nodeId: string }) {
  const [labels, setLabels] = useState<string[]>([]);
  useEffect(() => {
    let active = true, revision = 0;
    const read = async () => {
      const request = ++revision;
      try {
        const runs = await nodeRuns.read(nodeId);
        if (active && request === revision) setLabels(submittedVoiceLabels(nodeId, runs));
      } catch { if (active && request === revision) setLabels([]); }
    };
    const unsubscribe=nodeRuns.subscribe(nodeId,()=>void read());
    void read();
    return () => { active = false; unsubscribe(); };
  }, [nodeId]);
  return labels.length ? <div className="creative-batch-note" role="status" aria-label="最近一次任务声音提交记录">{labels.map(label => <div key={label}>最近一次任务：已提交 {label}</div>)}</div> : null;
}
