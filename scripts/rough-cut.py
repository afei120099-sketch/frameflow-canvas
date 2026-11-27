"""Frameflow Phase 19: Final Cut rough export (CPU-only PyAV).

Run with the existing ComfyUI embedded Python. Never imports ComfyUI, never touches source files;
the caller owns the job directory (sources, plan.json, output) and removes it afterwards.

    rough-cut.py plan   <plan.json>                → JSON: real media info + decided output spec
    rough-cut.py render <plan.json> <output.mp4>   → JSON lines on stdout (progress), last line = result

plan.json: {"sizePolicy": "first" | "largest" | "1920x1080" | …,
            "clips": [{"source": path, "inPoint": s, "outPoint": s, "title": str, "filename": str}]}

Output spec (deterministic, see decide_fps / decide_size):
  MP4, H.264 (libx264, yuv420p, CRF 18, preset veryfast), AAC 48 kHz stereo 192 kb/s, faststart.
  Every clip is decoded, trimmed on real media timestamps, fitted (no stretch, black bars) and
  re-encoded; clips are joined with hard cuts. Clips without audio get silence. Processing is one
  clip at a time with streaming decode — whole videos are never loaded into memory.
"""

import argparse
from fractions import Fraction
import json
import math
from pathlib import Path
import sys

import av
import numpy as np

RATE = 48000
AAC_FRAME = 1024
MAX_EDGE = 4096
FPS_EPSILON = 0.01
FRAME_EPSILON = 1e-4
# Asset durations in the canvas are recorded to 0.1 s; an out point this close past the real end is the end.
END_TOLERANCE = 0.25
SIZE_PRESETS = {"1920x1080": (1920, 1080), "1280x720": (1280, 720), "1080x1920": (1080, 1920), "720x1280": (720, 1280), "1080x1080": (1080, 1080)}
ENCODER = {"video": "libx264", "crf": "18", "preset": "veryfast", "audio": "aac", "audioBitRate": 192000}


class RoughCutError(Exception):
    def __init__(self, code, message, clip=None, stage=None, detail=None):
        super().__init__(message)
        self.code, self.clip, self.stage, self.detail = code, clip, stage, detail

    def payload(self):
        return {"code": self.code, "message": str(self), "clip": self.clip, "stage": self.stage, "detail": self.detail}


def emit(event, **data):
    print(json.dumps({"event": event, **data}, ensure_ascii=False), flush=True)


def fraction_text(value):
    return f"{value.numerator}/{value.denominator}"


# ——— probing ———

def stream_seconds(stream, value):
    return float(value * stream.time_base) if value is not None else None


def probe(path):
    """Real media facts, re-read from the file (never the Asset record's rounded metadata)."""
    with av.open(str(path)) as container:
        video = next(iter(container.streams.video), None)
        if video is None:
            raise RoughCutError("NO_VIDEO_STREAM", "文件里没有视频流")
        rate = video.average_rate or video.guessed_rate or video.base_rate
        if not rate or float(rate) <= 0:
            raise RoughCutError("UNKNOWN_FPS", "无法读取视频帧率")
        rate = Fraction(rate).limit_denominator(1001)
        base = container.start_time / av.time_base if container.start_time is not None else 0.0
        duration = stream_seconds(video, video.duration)
        if duration is None and container.duration is not None:
            duration = float(container.duration / av.time_base)
        if duration is None:
            # Fragmented MP4 (e.g. browser recordings) may carry no duration: read packet timestamps (no decoding).
            last = None
            for packet in container.demux(video):
                if packet.pts is not None:
                    end = (packet.pts + (packet.duration or 0)) * packet.time_base
                    last = end if last is None else max(last, end)
            duration = float(last) - base if last is not None else None
        if not duration or duration <= 0:
            raise RoughCutError("UNKNOWN_DURATION", "无法读取视频真实时长")
        audio = next(iter(container.streams.audio), None)
        return {
            "fps": rate, "width": video.codec_context.width, "height": video.codec_context.height,
            "duration": duration, "base": base, "videoCodec": video.codec_context.name,
            "hasAudio": audio is not None, "audioCodec": audio.codec_context.name if audio else None,
            "audioRate": audio.rate if audio else None, "audioChannels": audio.codec_context.layout.nb_channels if audio else None,
        }


def resolve_ranges(clips, infos):
    """Validate each in/out against the real duration; a tiny overrun is the end, a real one is an error."""
    ranges, warnings = [], []
    for index, (clip, info) in enumerate(zip(clips, infos), 1):
        start, end, real = float(clip["inPoint"]), float(clip["outPoint"]), info["duration"]
        if not (math.isfinite(start) and math.isfinite(end)) or start < 0 or end - start <= 0:
            raise RoughCutError("INVALID_RANGE", f"入点 / 出点无效（{start} → {end}）", index, "check")
        if start >= real:
            raise RoughCutError("INVALID_RANGE", f"入点 {start:.3f} 秒不在视频内（真实时长 {real:.3f} 秒）", index, "check")
        if end > real + END_TOLERANCE:
            raise RoughCutError("INVALID_RANGE", f"出点 {end:.3f} 秒超出视频真实时长 {real:.3f} 秒", index, "check")
        if end > real:
            warnings.append(f"第 {index} 段出点 {end:.3f} 秒比真实时长 {real:.3f} 秒多 {end - real:.3f} 秒，已按视频真实结尾")
            end = real
        ranges.append((start, end))
    return ranges, warnings


# ——— deterministic output spec ———

def decide_fps(infos, ranges):
    """All clips share one rate → keep it. Mixed → 48 when clips at ≈48 fps (FILM) make up at least
    half of the cut's duration, otherwise 24. Never invents 60."""
    rates = [info["fps"] for info in infos]
    if all(abs(float(rate) - float(rates[0])) < FPS_EPSILON for rate in rates):
        return rates[0], "same"
    total = sum(end - start for start, end in ranges)
    at48 = sum(end - start for (start, end), rate in zip(ranges, rates) if abs(float(rate) - 48) < 0.5)
    if at48 * 2 >= total:
        return Fraction(48), "mixed_48_majority"
    return Fraction(24), "mixed_default_24"


def even(value):
    return max(2, int(value) // 2 * 2)


def decide_size(infos, policy):
    if policy == "first":
        width, height = infos[0]["width"], infos[0]["height"]
    elif policy == "largest":
        largest = max(range(len(infos)), key=lambda i: (infos[i]["width"] * infos[i]["height"], -i))
        width, height = infos[largest]["width"], infos[largest]["height"]
    elif policy in SIZE_PRESETS:
        width, height = SIZE_PRESETS[policy]
    else:
        raise RoughCutError("INVALID_SIZE_POLICY", f"未知输出尺寸：{policy}")
    scale = min(1.0, MAX_EDGE / max(width, height))
    return even(width * scale), even(height * scale)


def fit(src_w, src_h, width, height):
    """Scale to fit inside the canvas keeping the aspect ratio; centred; even sizes/offsets for 4:2:0."""
    scale = min(width / src_w, height / src_h)
    fit_w = min(width, max(2, round(src_w * scale / 2) * 2))
    fit_h = min(height, max(2, round(src_h * scale / 2) * 2))
    return fit_w, fit_h, (width - fit_w) // 4 * 2, (height - fit_h) // 4 * 2


def spec(clips, infos, ranges, policy):
    fps, fps_reason = decide_fps(infos, ranges)
    width, height = decide_size(infos, policy)
    clip_frames = [max(1, round(Fraction(end - start) * fps)) for start, end in ranges]
    boundaries = transition_plan(clips, clip_frames, fps)
    total_frames = sum(clip_frames)-sum(n for kind,n in boundaries if kind=="dissolve")
    reasons = []
    for index, info in enumerate(infos, 1):
        why = []
        if abs(float(info["fps"]) - float(fps)) >= FPS_EPSILON:
            why.append(f"{float(info['fps']):g}→{float(fps):g} FPS")
        if (info["width"], info["height"]) != (width, height):
            why.append(f"{info['width']}×{info['height']} 适配到 {width}×{height}")
        if not info["hasAudio"]:
            why.append("无音轨，补静音")
        if why:
            reasons.append({"clip": index, "reasons": why})
    return {
        "fps": fraction_text(fps), "fpsValue": float(fps), "fpsReason": fps_reason,
        "width": width, "height": height, "sizePolicy": policy,
        "frames": total_frames, "duration": float(total_frames / fps),
        "clipFrames": clip_frames, "reencode": True, "unify": reasons,
        "encoder": ENCODER,
    }, fps


def load_plan(plan_path):
    plan = json.loads(Path(plan_path).read_text(encoding="utf-8"))
    clips = plan.get("clips") or []
    if not clips:
        raise RoughCutError("EMPTY_PLAN", "没有可输出的片段", None, "check")
    return plan, clips


def probe_all(clips, report=False):
    infos = []
    for index, clip in enumerate(clips, 1):
        if report:
            emit("stage", stage="probe", index=index, total=len(clips), title=clip.get("title"))
        try:
            infos.append(probe(clip["source"]))
        except RoughCutError as cause:
            cause.clip, cause.stage = index, "probe"
            raise
        except (av.FFmpegError, OSError, ValueError) as cause:
            raise RoughCutError("UNREADABLE_MEDIA", "无法读取该视频（文件损坏或格式不受支持）", index, "probe", str(cause)) from cause
    return infos


def run_plan(plan_path):
    plan, clips = load_plan(plan_path)
    infos = probe_all(clips)
    ranges, warnings = resolve_ranges(clips, infos)
    output, _ = spec(clips, infos, ranges, plan.get("sizePolicy", "first"))
    return {"output": output, "warnings": warnings, "clips": [{
        "index": index, "fps": float(info["fps"]), "width": info["width"], "height": info["height"],
        "duration": info["duration"], "hasAudio": info["hasAudio"], "videoCodec": info["videoCodec"],
        "audioCodec": info["audioCodec"], "inPoint": start, "outPoint": end,
    } for index, (info, (start, end)) in enumerate(zip(infos, ranges), 1)]}


# ——— rendering (one clip at a time, streaming decode) ———

def clip_frames(path, info, start, count, fps):
    """`count` output frames at start + k/fps, each the latest source frame not after that time
    (duplicates when converting up, drops when converting down)."""
    with av.open(str(path)) as container:
        video = container.streams.video[0]
        # Short seeks stop decoding early: avoid frame-thread workers during teardown.
        video.codec_context.thread_count = 1
        video.thread_type = "SLICE"
        base = info["base"]
        try:
            container.seek(int((start + base) / video.time_base), stream=video, backward=True)
        except (av.FFmpegError, OverflowError):
            container.seek(0)
        frames = container.decode(video)
        try:
            current, upcoming = None, next(frames, None)
            step = 1 / float(fps)
            # Holding the last frame is only right for the final source frame; a stream that ends well
            # before the requested point is damaged or truncated and must fail, never be padded silently.
            slack = max(2 / float(info["fps"]), 0.1)
            for k in range(count):
                target = start + k * step
                while upcoming is not None and upcoming.time is not None and upcoming.time - base <= target + FRAME_EPSILON:
                    current, upcoming = upcoming, next(frames, None)
                if current is None:
                    current = upcoming
                if current is None:
                    raise RoughCutError("NO_FRAMES", "指定范围内没有可解码的画面")
                if upcoming is None and current.time is not None and target > current.time - base + slack:
                    raise RoughCutError("TRUNCATED_MEDIA", f"视频数据在 {current.time - base:.2f} 秒处中断（文件不完整或已损坏）")
                yield current
        finally:
            frames.close()


def clip_audio(path, info, start, samples):
    """Exactly `samples` stereo float samples from `start`, resampled to 48 kHz; gaps and missing
    audio become silence so the output track is continuous."""
    if not info["hasAudio"]:
        remaining = samples
        while remaining > 0:
            chunk = min(remaining, 8192)
            yield np.zeros((2, chunk), np.float32)
            remaining -= chunk
        return
    with av.open(str(path)) as container:
        audio = container.streams.audio[0]
        audio.codec_context.thread_count = 1
        base = info["base"]
        try:
            container.seek(int((start + base) / audio.time_base), stream=audio, backward=True)
        except (av.FFmpegError, OverflowError):
            container.seek(0)
        # Mono is resampled as mono and copied to both channels unchanged (the default mono→stereo
        # remix lowers the level ~3 dB; this stage must not change loudness). >2 channels: standard downmix.
        mono = audio.codec_context.layout.nb_channels == 1
        resampler = av.AudioResampler(format="fltp", layout="mono" if mono else "stereo", rate=RATE)
        begin = round(start * RATE)
        produced = 0

        def take(frame):
            nonlocal produced
            if produced >= samples:
                return None
            data = frame.to_ndarray().astype(np.float32, copy=False)
            if data.ndim == 1 or data.shape[0] == 1:
                data = np.vstack([data.reshape(-1), data.reshape(-1)])
            frame_start = round((float(frame.pts * frame.time_base) - base) * RATE) if frame.pts is not None else begin + produced
            wanted = begin + produced
            pieces = []
            if frame_start > wanted:  # gap in the source → silence up to this frame
                gap = min(frame_start - wanted, samples - produced)
                pieces.append(np.zeros((2, gap), np.float32))
                produced += gap
                wanted += gap
            offset = wanted - frame_start
            if 0 <= offset < data.shape[1] and produced < samples:
                piece = data[:, offset:offset + (samples - produced)]
                pieces.append(np.ascontiguousarray(piece))
                produced += piece.shape[1]
            return pieces

        for decoded in container.decode(audio):
            for frame in resampler.resample(decoded):
                pieces = take(frame)
                if pieces is None:
                    break
                yield from pieces
            if produced >= samples:
                break
        if produced < samples:
            for frame in resampler.resample(None):
                pieces = take(frame)
                if pieces:
                    yield from pieces
        if produced < samples:
            yield np.zeros((2, samples - produced), np.float32)


class AudioWriter:
    """Feeds the AAC encoder exactly 1024-sample frames across clip boundaries (continuous track)."""

    def __init__(self, container, stream):
        self.container, self.stream = container, stream
        self.buffer = np.zeros((2, 0), np.float32)
        self.pts = 0

    def push(self, samples):
        self.buffer = np.concatenate([self.buffer, samples], axis=1) if self.buffer.shape[1] else samples
        while self.buffer.shape[1] >= AAC_FRAME:
            self._encode(self.buffer[:, :AAC_FRAME])
            self.buffer = self.buffer[:, AAC_FRAME:]

    def _encode(self, samples):
        frame = av.AudioFrame.from_ndarray(np.ascontiguousarray(samples, dtype=np.float32), format="fltp", layout="stereo")
        frame.sample_rate = RATE
        frame.pts = self.pts
        frame.time_base = Fraction(1, RATE)
        self.pts += samples.shape[1]
        for packet in self.stream.encode(frame):
            self.container.mux(packet)

    def close(self):
        if self.buffer.shape[1]:
            self._encode(self.buffer)
            self.buffer = np.zeros((2, 0), np.float32)
        for packet in self.stream.encode(None):
            self.container.mux(packet)


def letterboxed(frame, width, height, cache):
    """Source frame → canvas-sized yuv420p frame data (fit, centred, black bars). Cached per source
    frame so repeated frames (rate conversion) are converted once."""
    key = id(frame)
    if cache.get("key") == key:
        return cache["data"]
    fit_w, fit_h, x0, y0 = fit(frame.width, frame.height, width, height)
    scaled = frame.reformat(width=fit_w, height=fit_h, format="yuv420p", interpolation="BICUBIC").to_ndarray()
    y = scaled[:fit_h]
    chroma = scaled[fit_h:].reshape(-1)
    quarter = (fit_h // 2) * (fit_w // 2)
    u, v = chroma[:quarter].reshape(fit_h // 2, fit_w // 2), chroma[quarter:].reshape(fit_h // 2, fit_w // 2)
    canvas_y = np.full((height, width), 16, np.uint8)
    canvas_u = np.full((height // 2, width // 2), 128, np.uint8)
    canvas_v = np.full((height // 2, width // 2), 128, np.uint8)
    canvas_y[y0:y0 + fit_h, x0:x0 + fit_w] = y
    canvas_u[y0 // 2:y0 // 2 + fit_h // 2, x0 // 2:x0 // 2 + fit_w // 2] = u
    canvas_v[y0 // 2:y0 // 2 + fit_h // 2, x0 // 2:x0 // 2 + fit_w // 2] = v
    data = np.concatenate([canvas_y.ravel(), canvas_u.ravel(), canvas_v.ravel()]).reshape(height * 3 // 2, width)
    cache["key"], cache["data"], cache["frame"] = key, data, frame
    return data



def transition_plan(clips, counts, fps):
    boundaries = []
    for index, clip in enumerate(clips):
        transition = clip.get("transition") or {}
        kind = transition.get("type", "cut") if index else "cut"
        seconds = transition.get("seconds", 0.25)
        if kind not in ("cut", "dissolve", "fade") or not isinstance(seconds, (int,float)) or not 0.05 <= seconds <= 1:
            raise RoughCutError("INVALID_TRANSITION", "转场参数无效", index+1, "check")
        count = max(1, round(float(fps)*seconds)) if kind != "cut" else 0
        boundaries.append((kind, count))
    for i,count in enumerate(counts):
        incoming = boundaries[i][1]
        outgoing = boundaries[i+1][1] if i+1<len(counts) else 0
        if incoming+outgoing > count:
            raise RoughCutError("TRANSITION_TOO_LONG", "片段过短，请缩短转场或改用硬切", i+1, "check")
    return boundaries


def render_transitions(clips, infos, ranges, output, fps, target):
    """At most two short transition windows in RAM; no full-video buffering."""
    from collections import deque
    width,height=output["width"],output["height"]
    boundaries=transition_plan(clips,output["clipFrames"],fps)
    done=0
    with av.open(str(target),mode="w",format="mp4",options={"movflags":"+faststart"}) as container:
        video=container.add_stream(ENCODER["video"],rate=fps)
        video.width,video.height,video.pix_fmt=width,height,"yuv420p"
        video.codec_context.thread_count=2
        video.options={"crf":ENCODER["crf"],"preset":ENCODER["preset"]}
        audio=container.add_stream(ENCODER["audio"],rate=RATE)
        audio.layout="stereo"
        audio.codec_context.thread_count=1
        audio.bit_rate=ENCODER["audioBitRate"]
        writer=AudioWriter(container,audio)

        def write(pair):
            nonlocal done
            picture,sound=pair
            # One continuous output sample clock, including overlap removal.
            needed=round(Fraction(done+1)*RATE/fps)-round(Fraction(done)*RATE/fps)
            if sound.shape[1] != needed:
                old=np.arange(sound.shape[1])
                points=np.linspace(0,max(0,sound.shape[1]-1),needed)
                sound=np.stack([np.interp(points,old,channel) for channel in sound]).astype(np.float32)
            frame=av.VideoFrame.from_ndarray(picture,format="yuv420p")
            frame.pts=done
            frame.time_base=Fraction(1,1)/fps
            for packet in video.encode(frame): container.mux(packet)
            writer.push(sound)
            done+=1

        def frames_for(index):
            clip,info,(start,end),count=clips[index],infos[index],ranges[index],output["clipFrames"][index]
            source=clip.get("audioSource",clip["source"])
            sound_info=probe(source) if clip.get("audioSource") else info
            sound=iter(clip_audio(source,sound_info,float(clip.get("audioInPoint",start)),round(Fraction(count)*RATE/fps)))
            remaining=np.empty((2,0),dtype=np.float32)
            cache={}
            for k,frame in enumerate(clip_frames(clip["source"],info,start,count,fps)):
                needed=round(Fraction(k+1)*RATE/fps)-round(Fraction(k)*RATE/fps)
                while remaining.shape[1]<needed:
                    try: remaining=np.concatenate((remaining,next(sound)),axis=1)
                    except StopIteration: raise RoughCutError("AUDIO_UNDERRUN","转场音频数据不足",index+1,"clip")
                chunk,remaining=remaining[:,:needed],remaining[:,needed:]
                yield letterboxed(frame,width,height,cache).copy(),chunk

        def blend(a,b,weight):
            left,right=a[1],b[1]
            if left.shape[1]!=right.shape[1]:
                right=np.stack([np.interp(np.linspace(0,right.shape[1]-1,left.shape[1]),np.arange(right.shape[1]),c) for c in right]).astype(np.float32)
            return (np.clip(a[0].astype(np.float32)*(1-weight)+b[0].astype(np.float32)*weight,0,255).astype(np.uint8), left*(1-weight)+right*weight)

        black=np.full((height*3//2,width),128,np.uint8)
        black[:height]=16
        pending=[]
        for i in range(len(clips)):
            emit("stage",stage="clip",index=i+1,total=len(clips),title=clips[i].get("title"))
            stream=iter(frames_for(i))
            kind,count=boundaries[i]
            if kind!="cut":
                head=[next(stream) for _ in range(count)]
                if kind=="dissolve":
                    for k,(left,right) in enumerate(zip(pending,head)):
                        write(blend(left,right,(k+1)/(count+1)))
                else:
                    for k,pair in enumerate(pending):
                        write(blend(pair,(black,np.zeros_like(pair[1])),(k+1)/count))
                    for k,pair in enumerate(head):
                        write(blend((black,np.zeros_like(pair[1])),pair,(k+1)/count))
            keep=boundaries[i+1][1] if i+1<len(clips) else 0
            tail=deque()
            for pair in stream:
                tail.append(pair)
                if len(tail)>keep: write(tail.popleft())
            pending=list(tail)
        for packet in video.encode(None): container.mux(packet)
        writer.close()
    if done!=output["frames"]:
        target.unlink(missing_ok=True)
        raise RoughCutError("FRAME_COUNT","转场输出帧数不一致",None,"finalize")
    return done


def render(plan_path, output_path):
    plan, clips = load_plan(plan_path)
    infos = probe_all(clips, report=True)
    ranges, warnings = resolve_ranges(clips, infos)
    output, fps = spec(clips, infos, ranges, plan.get("sizePolicy", "first"))
    width, height = output["width"], output["height"]
    target = Path(output_path)
    target.unlink(missing_ok=True)
    frames_done, results = 0, []
    if any((c.get("transition") or {}).get("type","cut") != "cut" for c in clips[1:]):
        try:
            frames_done=render_transitions(clips,infos,ranges,output,fps,target)
            return {**output,"frames":frames_done,"clips":[{"index":i+1,"frames":count,"seconds":float(Fraction(count)/fps),"inPoint":ranges[i][0],"outPoint":ranges[i][1]} for i,count in enumerate(output["clipFrames"])],"warnings":warnings,"bytes":target.stat().st_size}
        except Exception:
            target.unlink(missing_ok=True)
            raise
    try:
        with av.open(str(target), mode="w", format="mp4", options={"movflags": "+faststart"}) as container:
            video = container.add_stream(ENCODER["video"], rate=fps)
            video.width, video.height, video.pix_fmt = width, height, "yuv420p"
            video.codec_context.thread_count = 2
            video.options = {"crf": ENCODER["crf"], "preset": ENCODER["preset"]}
            audio = container.add_stream(ENCODER["audio"], rate=RATE)
            audio.layout = "stereo"
            audio.codec_context.thread_count = 1
            audio.bit_rate = ENCODER["audioBitRate"]
            writer = AudioWriter(container, audio)
            for index, (clip, info, (start, end), count) in enumerate(zip(clips, infos, ranges, output["clipFrames"]), 1):
                emit("stage", stage="clip", index=index, total=len(clips), title=clip.get("title"))
                clip_first_sample = round(Fraction(frames_done) * RATE / fps)
                clip_samples = round(Fraction(frames_done + count) * RATE / fps) - clip_first_sample
                # Segmented enhancement restores sound from the unprocessed original,
                # not independently encoded AI chunk soundtracks. One AAC encoder spans all chunks.
                sound_source = clip.get("audioSource", clip["source"])
                sound_info = probe(sound_source) if clip.get("audioSource") else info
                sound_start = float(clip.get("audioInPoint", start))
                if sound_start < 0 or sound_start >= sound_info["duration"]:
                    raise RoughCutError("INVALID_RANGE", "原音轨时间不在视频范围内", index, "clip")
                sound = clip_audio(sound_source, sound_info, sound_start, clip_samples)
                pushed, cache = 0, {}
                pictures = clip_frames(clip["source"], info, start, count, fps)
                try:
                    for k, frame in enumerate(pictures):
                        out = av.VideoFrame.from_ndarray(letterboxed(frame, width, height, cache), format="yuv420p")
                        out.pts = frames_done + k
                        out.time_base = Fraction(1, 1) / fps
                        for packet in video.encode(out):
                            container.mux(packet)
                        # Keep the audio in step with the picture (interleaved, never buffered per clip).
                        due = round(Fraction(frames_done + k + 1) * RATE / fps) - clip_first_sample
                        while pushed < due:
                            chunk = next(sound)
                            writer.push(chunk)
                            pushed += chunk.shape[1]
                    for chunk in sound:
                        writer.push(chunk)
                        pushed += chunk.shape[1]
                except RoughCutError as cause:
                    cause.clip, cause.stage = index, cause.stage or "clip"
                    raise
                except StopIteration as cause:
                    raise RoughCutError("AUDIO_UNDERRUN", "音频数据不足", index, "clip") from cause
                except (av.FFmpegError, OSError, ValueError) as cause:
                    raise RoughCutError("CLIP_FAILED", "裁切或转码失败（文件可能损坏）", index, "clip", str(cause)) from cause
                finally:
                    pictures.close()
                    sound.close()
                if pushed != clip_samples:
                    raise RoughCutError("AUDIO_LENGTH", f"音频长度不一致（{pushed} / {clip_samples}）", index, "clip")
                results.append({"index": index, "frames": count, "seconds": float(Fraction(count) / fps), "inPoint": start, "outPoint": end, "samples": clip_samples})
                frames_done += count
            emit("stage", stage="finalize", total=len(clips))
            for packet in video.encode(None):
                container.mux(packet)
            writer.close()
    except RoughCutError:
        target.unlink(missing_ok=True)
        raise
    except (av.FFmpegError, OSError, ValueError) as cause:
        target.unlink(missing_ok=True)
        raise RoughCutError("ENCODE_FAILED", "写入粗剪文件失败", None, "finalize", str(cause)) from cause
    return {**output, "clips": results, "warnings": warnings, "bytes": target.stat().st_size}


def main():
    # Piped stdout on Windows defaults to the ANSI code page; the caller always reads UTF-8 JSON.
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser()
    parser.add_argument("operation", choices=["plan", "render"])
    parser.add_argument("plan", type=Path)
    parser.add_argument("output", nargs="?", type=Path)
    args = parser.parse_args()
    try:
        if args.operation == "plan":
            print(json.dumps(run_plan(args.plan), ensure_ascii=False))
        else:
            if args.output is None:
                raise RoughCutError("INVALID_OUTPUT", "缺少输出文件路径")
            emit("done", result=render(args.plan, args.output))
    except RoughCutError as cause:
        print(json.dumps(cause.payload(), ensure_ascii=False), file=sys.stderr)
        raise SystemExit(2) from cause


if __name__ == "__main__":
    main()
