"""Frameflow production line: automatic first-pass checks. CPU only, read-only on its inputs.

Run with the ComfyUI embedded Python (insightface, onnxruntime, PyAV, numpy already installed there).

    production-checks.py face  <reference.png> <candidate.png> [...]   → JSON {"results": [{"file", "faces", "face"}]}
    production-checks.py video <clip.mp4> <expected_seconds>            → JSON {"duration", "hasAudio", "blackFrames", "frozenRatio", "problems"}

face: cosine similarity between the largest face in the reference and the best-matching face in each
candidate (antelopev2, the same detector PuLID uses). null when no face is found.
video: duration, audio stream presence, near-black sampled frames and the share of sampled frames that
barely differ from the previous one (frozen picture).
"""

import json
import os
import sys
from pathlib import Path

COMFY = Path(os.environ.get("FRAMEFLOW_COMFYUI_ROOT") or os.environ.get("FRAMEFLOW_COMFYUI_DIR") or r"C:\ComfyUI_windows_portable\ComfyUI")


def face_scores(reference, candidates):
    import cv2
    import numpy as np
    from insightface.app import FaceAnalysis

    app = FaceAnalysis(name="antelopev2", root=str(COMFY / "models" / "insightface"), providers=["CPUExecutionProvider"])
    app.prepare(ctx_id=-1, det_size=(640, 640))

    def faces(path):
        image = cv2.imdecode(np.fromfile(path, dtype=np.uint8), cv2.IMREAD_COLOR)
        if image is None:
            raise ValueError(f"读不出图片：{path}")
        return app.get(image)

    ref_faces = faces(reference)
    if not ref_faces:
        return {"error": "参考脸图里没有检测到人脸", "results": []}
    ref = max(ref_faces, key=lambda f: (f.bbox[2] - f.bbox[0]) * (f.bbox[3] - f.bbox[1])).normed_embedding
    results = []
    for path in candidates:
        try:
            found = faces(path)
            best = max((float(np.dot(ref, f.normed_embedding)) for f in found), default=None)
            results.append({"file": path, "faces": len(found), "face": None if best is None else round(best, 4)})
        except Exception as error:  # one bad candidate must not hide the others
            results.append({"file": path, "faces": 0, "face": None, "error": str(error)[:300]})
    return {"results": results}


def video_check(path, expected):
    import av
    import numpy as np

    problems = []
    with av.open(path) as container:
        has_audio = any(stream.type == "audio" for stream in container.streams)
        stream = container.streams.video[0]
        duration = float(container.duration / av.time_base) if container.duration else float(stream.duration * stream.time_base) if stream.duration else 0.0
        frames = stream.frames or 0
        step = max(1, frames // 48) if frames else 6
        black = 0
        frozen = 0
        sampled = 0
        previous = None
        for index, frame in enumerate(container.decode(stream)):
            if index % step:
                continue
            gray = frame.to_ndarray(format="gray").astype(np.float32)
            gray = gray[:: max(1, gray.shape[0] // 180), :: max(1, gray.shape[1] // 320)]
            sampled += 1
            if gray.mean() < 12:
                black += 1
            if previous is not None and previous.shape == gray.shape and float(np.abs(gray - previous).mean()) < 0.6:
                frozen += 1
            previous = gray
    frozen_ratio = round(frozen / max(1, sampled - 1), 3)
    if expected and abs(duration - expected) > 1.0:
        problems.append(f"时长 {duration:.1f}s，和要求的 {expected:.1f}s 差得多")
    if black:
        problems.append(f"{black} 个抽样帧接近全黑")
    if frozen_ratio > 0.5:
        problems.append(f"{int(frozen_ratio * 100)}% 的抽样帧几乎不动（可能是定格）")
    return {"duration": round(duration, 3), "hasAudio": has_audio, "blackFrames": black, "frozenRatio": frozen_ratio, "sampled": sampled, "problems": problems}


def main(argv):
    if len(argv) >= 3 and argv[0] == "face":
        print(json.dumps(face_scores(argv[1], argv[2:]), ensure_ascii=False))
        return 0
    if len(argv) == 3 and argv[0] == "video":
        print(json.dumps(video_check(argv[1], float(argv[2])), ensure_ascii=False))
        return 0
    print(json.dumps({"error": "用法：face <ref> <cand...> | video <clip> <seconds>"}, ensure_ascii=False))
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
