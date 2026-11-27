"""CPU PyAV inspection. No inference, network, ComfyUI, or source modification."""
import base64
import io
import json
import sys
import av
import numpy as np


def inspect(path):
    with av.open(path) as container:
        video = next(iter(container.streams.video), None)
        if video is None:
            raise ValueError("没有视频流")
        if video.width > 4096 or video.height > 4096:
            raise ValueError("目前只检查不超过 4096 像素的视频")
        duration = float(video.duration * video.time_base) if video.duration is not None else (container.duration or 0) / av.time_base
        if not 0 < duration <= 600:
            raise ValueError("目前只检查 0–600 秒的视频")
        fps = float(video.average_rate or video.guessed_rate or 0)
        targets = np.linspace(0, max(0, duration - (1 / fps if fps else 0.05)), 12)
        frames, samples, black_runs, black_start, last, first = 0, [], [], None, 0, None
        frozen_runs, frozen_start, previous = [], None, None
        audio_count = 0
        # Demux both streams: decode failures are errors, never labelled a clean result.
        for packet in container.demux():
            if packet.stream.type not in ("video", "audio"):
                continue
            for frame in packet.decode():
                if packet.stream.type == "audio":
                    audio_count += 1
                    continue
                frames += 1
                if frames > 36000:
                    raise ValueError("超过 36000 帧检查上限")
                raw_time = float(frame.time or 0)
                if first is None:
                    first = raw_time
                time = max(0, raw_time - first)
                last = time
                small = frame.reformat(width=64, height=64, format="rgb24").to_ndarray()
                luma = small.mean(axis=2)
                # Still images are warnings, not proof of a failed render.
                stable = previous is not None and float(np.abs(small.astype(np.float32)-previous).mean()) < 0.25
                if stable and frozen_start is None:
                    frozen_start = max(0, time - (1 / fps if fps else 0))
                if not stable and frozen_start is not None:
                    if time-frozen_start >= 2: frozen_runs.append([round(frozen_start,3),round(time,3)])
                    frozen_start = None
                previous = small.astype(np.float32)
                dark = float((luma < 12).mean()) >= 0.98
                if dark and black_start is None:
                    black_start = time
                if not dark and black_start is not None:
                    black_runs.append([round(black_start, 3), round(time, 3)])
                    black_start = None
                if len(samples) < 12 and time + 0.0001 >= targets[len(samples)]:
                    width = 320
                    height = max(2, int(frame.height * width / frame.width))
                    image = frame.reformat(width=width, height=height).to_image()
                    output = io.BytesIO()
                    image.save(output, format="JPEG", quality=80)
                    samples.append({"time": round(time, 3), "image": "data:image/jpeg;base64," + base64.b64encode(output.getvalue()).decode("ascii")})
        if not frames:
            raise ValueError("无法解码任何视频帧")
        if black_start is not None:
            black_runs.append([round(black_start, 3), round(last + (1 / fps if fps else 0), 3)])
        if frozen_start is not None and last-frozen_start >= 2: frozen_runs.append([round(frozen_start,3),round(last+(1/fps if fps else 0),3)])
        warnings = []
        if black_runs:
            warnings.append("检测到近黑画面，可能是淡入淡出或夜景，请人工确认")
        if not audio_count:
            warnings.append("没有解码到音频；若要求静音则正常，否则检查音轨")
        decoded_duration = last + (1 / fps if fps else 0)
        if abs(decoded_duration - duration) > max(0.5, duration * 0.05):
            warnings.append("容器时长与已解码视频时长明显不同，请核对是否截断")
        return {"version": "media-audit-v1", "duration": duration, "decodedDuration": round(decoded_duration, 3), "width": video.width, "height": video.height, "fps": fps, "frames": frames, "hasAudio": audio_count > 0, "blackRanges": black_runs[:100], "freezeRanges": frozen_runs[:100], "warnings": warnings, "samples": samples, "scope": "完整视频/音频解码、低分辨率近黑检测；静止检测仅为疑似；不识别背景音乐、人物变形、台词或镜头语义"}


if __name__ == "__main__":
    try:
        print(json.dumps(inspect(sys.argv[1]), ensure_ascii=False))
    except Exception as error:
        print(json.dumps({"error": str(error)}, ensure_ascii=False), file=sys.stderr)
        sys.exit(1)
