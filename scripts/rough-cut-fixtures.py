"""Test-only helper for scripts/test-rough-cut.mjs (not used by the app).

    rough-cut-fixtures.py make <dir>                 → writes real H.264 test clips, prints their facts
    rough-cut-fixtures.py make-shots <dir>           → three H3-like shots for scripts/test-autopilot-m1.mjs
    rough-cut-fixtures.py inspect <file.mp4> <spec>  → stream facts, centre pixels, bar widths, audio RMS

Every fixture frame is a flat colour: R = clip marker, G = (source frame index × 4) mod 256, B = 64,
so an output frame tells which clip and which source frame it came from.
"""

from fractions import Fraction
import json
import os
from pathlib import Path
import sys

import av
import numpy as np

CLIPS = {
    # name: (width, height, fps, seconds, marker, audio: None | (hz, rate, layout))
    "a24_audio.mp4": (640, 360, 24, 4.0, 40, (440, 48000, "stereo")),
    "b48_silent_portrait.mp4": (480, 640, 48, 3.0, 110, None),
    "c24_mono441.mp4": (320, 240, 24, 5.0, 180, (880, 44100, "mono")),
    "d30_hd.mp4": (1280, 720, 30, 2.0, 250, (330, 48000, "stereo")),
}


def make_clip(path, width, height, fps, seconds, marker, audio):
    frames = round(seconds * fps)
    with av.open(str(path), "w") as container:
        video = container.add_stream("libx264", rate=fps)
        video.width, video.height, video.pix_fmt = width, height, "yuv420p"
        video.options = {"crf": "12", "preset": "veryfast", "g": str(fps)}
        sound = None
        if audio:
            hz, rate, layout = audio
            sound = container.add_stream("aac", rate=rate)
            sound.layout = layout
        for index in range(frames):
            image = np.empty((height, width, 3), np.uint8)
            image[:, :, 0] = marker
            image[:, :, 1] = (index * 4) % 256
            image[:, :, 2] = 64
            frame = av.VideoFrame.from_ndarray(image, format="rgb24")
            frame.pts = index
            frame.time_base = Fraction(1, fps)
            for packet in video.encode(frame):
                container.mux(packet)
        for packet in video.encode(None):
            container.mux(packet)
        if sound:
            hz, rate, layout = audio
            total = round(seconds * rate)
            channels = 2 if layout == "stereo" else 1
            for start in range(0, total, 1024):
                count = min(1024, total - start)
                t = (np.arange(start, start + count) / rate).astype(np.float64)
                tone = (np.sin(2 * np.pi * hz * t) * 0.3).astype(np.float32)
                data = np.vstack([tone] * channels)
                frame = av.AudioFrame.from_ndarray(np.ascontiguousarray(data), format="fltp", layout=layout)
                frame.sample_rate = rate
                frame.pts = start
                frame.time_base = Fraction(1, rate)
                for packet in sound.encode(frame):
                    container.mux(packet)
            for packet in sound.encode(None):
                container.mux(packet)

SHOTS = {
    # Autopilot M1 stand-ins for H3 T2VA output: same format family (24 fps, H.264 + AAC stereo 48 kHz), distinct markers / tones.
    "shot_01.mp4": (320, 180, 24, 2.0, 60, (440, 48000, "stereo")),
    "shot_02.mp4": (320, 180, 24, 2.0, 140, (660, 48000, "stereo")),
    "shot_03.mp4": (320, 180, 24, 2.0, 220, (880, 48000, "stereo")),
}


def make_shots(directory):
    directory = Path(directory)
    directory.mkdir(parents=True, exist_ok=True)
    for name, (width, height, fps, seconds, marker, audio) in SHOTS.items():
        make_clip(directory / name, width, height, fps, seconds, marker, audio)
    print(json.dumps({name: {"marker": spec[4], "seconds": spec[3], "fps": spec[2]} for name, spec in SHOTS.items()}))


def make(directory):
    directory = Path(directory)
    directory.mkdir(parents=True, exist_ok=True)
    facts = {}
    for name, (width, height, fps, seconds, marker, audio) in CLIPS.items():
        make_clip(directory / name, width, height, fps, seconds, marker, audio)
        facts[name] = {"width": width, "height": height, "fps": fps, "seconds": seconds, "marker": marker, "hasAudio": audio is not None}
    (directory / "broken.mp4").write_bytes(os.urandom(40_000))
    facts["broken.mp4"] = {"broken": True}
    print(json.dumps(facts))


def inspect(path, spec):
    spec = json.loads(spec)
    result = {}
    with av.open(str(path)) as container:
        video = container.streams.video[0]
        result["video"] = {"codec": video.codec_context.name, "pixFmt": video.codec_context.pix_fmt, "width": video.codec_context.width, "height": video.codec_context.height, "fps": float(video.average_rate), "profile": video.codec_context.profile}
        frames = []
        wanted = set(spec.get("frames", []))
        for index, frame in enumerate(container.decode(video)):
            if index in wanted:
                rgb = frame.to_ndarray(format="rgb24")
                h, w = rgb.shape[:2]
                centre = rgb[h // 2, w // 2].tolist()
                row = rgb[h // 2].astype(int)
                lit = np.where(row.sum(axis=1) > 60)[0]
                frames.append({"index": index, "centre": centre, "litWidth": int(lit[-1] - lit[0] + 1) if lit.size else 0, "left": rgb[h // 2, 2].tolist()})
        result["frameCount"] = index + 1
        result["frames"] = frames
    with av.open(str(path)) as container:
        audio = container.streams.audio[0]
        result["audio"] = {"codec": audio.codec_context.name, "rate": audio.rate, "channels": audio.codec_context.layout.nb_channels}
        chunks = []
        for frame in container.decode(audio):
            chunks.append(frame.to_ndarray().astype(np.float32))
        pcm = np.concatenate(chunks, axis=1) if chunks else np.zeros((2, 0), np.float32)
        result["audio"]["samples"] = int(pcm.shape[1])
        result["rms"] = []
        for start, end in spec.get("rms", []):
            part = pcm[:, int(start * audio.rate):int(end * audio.rate)]
            result["rms"].append(float(np.sqrt(np.mean(part ** 2))) if part.size else None)
    print(json.dumps(result))


if __name__ == "__main__":
    if sys.argv[1] == "make":
        make(sys.argv[2])
    elif sys.argv[1] == "make-shots":
        make_shots(sys.argv[2])
    else:
        inspect(sys.argv[2], sys.argv[3])
