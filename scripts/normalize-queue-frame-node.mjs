import assert from 'node:assert/strict';
/** Invert only the approved queue frame guard, ready token and idle caption. */
export function normalizeQueueFrameNode(source) {
  const changes=[
    ['import { SubmissionNotSentError, type AiGenerationStatus, type H3GenerationSettings, type H3GenerationUpdate, type H3GenerationOptions } from "@/lib/ai-adapter";','import { type AiGenerationStatus, type H3GenerationSettings, type H3GenerationUpdate, type H3GenerationOptions } from "@/lib/ai-adapter";'],
    ["import { queueFrameNodeWaiting } from '@/lib/shot-queue-frames';\n",''],
    ['    const frameWaiting = queueFrameNodeWaiting(editor.getShape(shape.id)?.meta, shape.meta.shotQueueFrameToken);\n    if (frameWaiting) { setError(frameWaiting); showCanvasToast(frameWaiting); if (enqueueOnly) throw new SubmissionNotSentError(frameWaiting); return; }\n',''],
    [" queueFrameToken: typeof shape.meta.shotQueueFrameToken === 'string' ? shape.meta.shotQueueFrameToken : undefined,",''],
    ["typeof shape.meta.shotQueueFrameSources === 'string' ? `${shape.meta.shotQueueFrameWaiting ? '等待来源视频 · ' : '独立片段 · '}${shape.meta.shotQueueFrameSources}` : ",''],
  ];
  for(const [from,to] of changes){assert.equal(source.split(from).length,2,'exact queue frame node edit must occur once');source=source.replace(from,to);}
  return source;
}
