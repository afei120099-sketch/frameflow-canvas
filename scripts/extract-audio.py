"""Local, CPU-only PyAV audio probe and WAV extraction for Frameflow.

Run with the existing ComfyUI embedded Python. This never imports ComfyUI or
changes its files; the caller owns and removes all temporary media files.
"""

import argparse
from fractions import Fraction
import json
import math
from pathlib import Path
import sys

import av


RATE = 48000


class MediaError(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


def duration_seconds(container, stream):
    if container.duration is not None:
        return float(container.duration / av.time_base)
    if stream and stream.duration is not None:
        return float(stream.duration * stream.time_base)
    raise MediaError("UNKNOWN_DURATION", "无法读取媒体时长")


def probe(path: Path):
    try:
        with av.open(str(path)) as container:
            audio = next(iter(container.streams.audio), None)
            return {
                "hasAudio": audio is not None,
                "duration": duration_seconds(container, audio),
                "audioCodec": audio.codec_context.name if audio else None,
                "audioSampleRate": audio.rate if audio else None,
            }
    except MediaError:
        raise
    except (av.FFmpegError, OSError, ValueError) as cause:
        raise MediaError("UNREADABLE_MEDIA", "无法读取该视频") from cause


def extract(source: Path, output: Path, start: float | None, end: float | None, source_label: str = "视频"):
    if source.resolve() == output.resolve():
        raise MediaError("INVALID_OUTPUT", f"不能覆盖源{source_label}")
    try:
        with av.open(str(source)) as container:
            audio = next(iter(container.streams.audio), None)
            if audio is None:
                raise MediaError("NO_AUDIO_STREAM", f"这个{source_label}没有可提取的声音")
            duration = duration_seconds(container, audio)
            first = 0.0 if start is None else start
            last = duration if end is None else end
            if not math.isfinite(first) or not math.isfinite(last) or first < 0 or last <= first or last > duration + 0.02:
                raise MediaError("INVALID_RANGE", f"截取范围无效；{source_label}总时长 {duration:.2f} 秒")
            last = min(last, duration)
            begin_sample = round(first * RATE)
            end_sample = round(last * RATE)
            resampler = av.AudioResampler(format="s16", layout="mono", rate=RATE)
            written = 0
            next_input_sample = 0

            with av.open(str(output), mode="w", format="wav") as target:
                stream = target.add_stream("pcm_s16le", rate=RATE, layout="mono")

                def write_frame(frame):
                    nonlocal written, next_input_sample
                    frame_start = round(float(frame.pts * frame.time_base) * RATE) if frame.pts is not None else next_input_sample
                    next_input_sample = frame_start + frame.samples
                    left = max(0, begin_sample - frame_start)
                    right = min(frame.samples, end_sample - frame_start)
                    if right <= left:
                        return
                    samples = frame.to_ndarray()[:, left:right].copy()
                    clipped = av.AudioFrame.from_ndarray(samples, format="s16", layout="mono")
                    clipped.sample_rate = RATE
                    clipped.pts = written
                    clipped.time_base = Fraction(1, RATE)
                    for packet in stream.encode(clipped):
                        target.mux(packet)
                    written += right - left

                for decoded in container.decode(audio=0):
                    for frame in resampler.resample(decoded):
                        write_frame(frame)
                    if next_input_sample >= end_sample:
                        break
                for frame in resampler.resample(None):
                    write_frame(frame)
                for packet in stream.encode(None):
                    target.mux(packet)

            if written == 0:
                raise MediaError("EMPTY_AUDIO", "所选片段没有可提取的声音")
            return {"duration": written / RATE, "sampleRate": RATE, "channels": 1, "codec": "pcm_s16le", "samples": written}
    except MediaError:
        output.unlink(missing_ok=True)
        raise
    except (av.FFmpegError, OSError, ValueError) as cause:
        output.unlink(missing_ok=True)
        raise MediaError("AUDIO_PROCESSING_FAILED", f"无法读取或保存该{source_label}音轨") from cause


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("operation", choices=["probe", "extract", "clip"])
    parser.add_argument("source", type=Path)
    parser.add_argument("output", nargs="?", type=Path)
    parser.add_argument("--start", type=float)
    parser.add_argument("--end", type=float)
    args = parser.parse_args()
    try:
        if args.operation == "probe":
            result = probe(args.source)
        else:
            if args.output is None:
                raise MediaError("INVALID_OUTPUT", "缺少输出文件路径")
            if args.operation == "clip" and (args.start is None or args.end is None):
                raise MediaError("INVALID_RANGE", "裁剪声音需要开始和结束时间")
            if args.operation == "clip" and args.end - args.start < 0.2 - 1e-6:
                raise MediaError("CLIP_TOO_SHORT", "选中的声音片段太短")
            result = extract(args.source, args.output, args.start, args.end, "声音" if args.operation == "clip" else "视频")
        print(json.dumps(result, ensure_ascii=False))
    except MediaError as cause:
        print(json.dumps({"code": cause.code, "message": str(cause)}, ensure_ascii=False), file=sys.stderr)
        raise SystemExit(2) from cause


if __name__ == "__main__":
    main()
