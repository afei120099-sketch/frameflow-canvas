"""CPU-only regression for the local PyAV helper, using an existing voiced MP4."""

import json
from pathlib import Path
import subprocess
import sys
from tempfile import TemporaryDirectory
from urllib.error import HTTPError
from urllib.request import Request, urlopen

import av


HELPER = Path(__file__).with_name("extract-audio.py")


def call(*arguments):
    return subprocess.run([sys.executable, str(HELPER), *map(str, arguments)], capture_output=True, text=True)


def verify_wav(path: Path, expected_duration: float):
    with av.open(str(path)) as container:
        audio = container.streams.audio[0]
        assert audio.codec_context.name == "pcm_s16le"
        assert audio.rate == 48000
        assert audio.codec_context.channels == 1
        assert abs(container.duration / av.time_base - expected_duration) < 0.03
        assert sum(frame.samples for frame in container.decode(audio=0)) > 0


def main():
    if len(sys.argv) not in (2, 3):
        raise SystemExit("Usage: python test-audio-extract.py <existing voiced MP4> [local endpoint base URL]")
    source = Path(sys.argv[1])
    with TemporaryDirectory(prefix="frameflow-audio-regression-") as directory:
        root = Path(directory)
        silent = root / "silent.mp4"
        with av.open(str(source)) as original, av.open(str(silent), "w") as target:
            video = target.add_stream_from_template(original.streams.video[0])
            for packet in original.demux(video=0):
                if packet.dts is not None:
                    packet.stream = video
                    target.mux(packet)

        silent_probe = call("probe", silent)
        assert silent_probe.returncode == 0, silent_probe.stderr
        assert json.loads(silent_probe.stdout)["hasAudio"] is False
        silent_extract = call("extract", silent, root / "empty.wav")
        assert silent_extract.returncode == 2
        assert json.loads(silent_extract.stderr)["code"] == "NO_AUDIO_STREAM"
        assert not (root / "empty.wav").exists()

        probe = call("probe", source)
        assert probe.returncode == 0, probe.stderr
        details = json.loads(probe.stdout)
        assert details["hasAudio"] is True
        whole = root / "whole.wav"
        full = call("extract", source, whole)
        assert full.returncode == 0, full.stderr
        full_details = json.loads(full.stdout)
        verify_wav(whole, full_details["duration"])

        clip = root / "clip.wav"
        clipped = call("extract", source, clip, "--start", "1.2", "--end", "3.2")
        assert clipped.returncode == 0, clipped.stderr
        clip_details = json.loads(clipped.stdout)
        assert abs(clip_details["duration"] - 2.0) < .03
        assert clip.stat().st_size < whole.stat().st_size
        verify_wav(clip, 2.0)

        audio_clip = root / "audio-clip.wav"
        from_audio = call("clip", whole, audio_clip, "--start", "3", "--end", "5")
        assert from_audio.returncode == 0, from_audio.stderr
        verify_wav(audio_clip, 2.0)
        assert audio_clip.read_bytes() != clip.read_bytes()
        too_short = call("clip", whole, root / "too-short.wav", "--start", "1", "--end", "1.1")
        assert too_short.returncode == 2
        assert json.loads(too_short.stderr)["code"] == "CLIP_TOO_SHORT"
        assert not (root / "too-short.wav").exists()

        bad_range = call("extract", source, root / "invalid.wav", "--start", "1.2", "--end", "100")
        assert bad_range.returncode == 2
        assert json.loads(bad_range.stderr)["code"] == "INVALID_RANGE"
        assert not (root / "invalid.wav").exists()
        if len(sys.argv) == 3:
            base = sys.argv[2].rstrip("/")
            def send(path, query):
                request = Request(f"{base}/__audio_extract?{query}", data=path.read_bytes(), headers={"Content-Type": "video/mp4"}, method="POST")
                try:
                    with urlopen(request, timeout=30) as response:
                        return response.status, response.headers, response.read()
                except HTTPError as error:
                    return error.code, error.headers, error.read()
            code, _, body = send(silent, "operation=probe")
            assert code == 200 and json.loads(body)["hasAudio"] is False
            code, _, body = send(silent, "operation=extract")
            assert code == 422 and json.loads(body)["code"] == "NO_AUDIO_STREAM"
            code, headers, body = send(source, "operation=extract&start=1.2&end=3.2")
            assert code == 200 and headers.get_content_type() == "audio/wav"
            assert abs(float(headers["X-Audio-Duration"]) - 2.0) < .03
            assert len(body) == clip.stat().st_size
            code, _, body = send(source, "operation=extract&start=1.2&end=100")
            assert code == 422 and json.loads(body)["code"] == "INVALID_RANGE"
            code, headers, body = send(whole, "operation=clip&start=3&end=5")
            assert code == 200 and headers.get_content_type() == "audio/wav"
            assert abs(float(headers["X-Audio-Duration"]) - 2.0) < .03
            assert len(body) == audio_clip.stat().st_size
            code, _, body = send(whole, "operation=clip&start=1&end=1.1")
            assert code == 422 and json.loads(body)["code"] == "CLIP_TOO_SHORT"
        print(json.dumps({"sourceAudioCodec": details["audioCodec"], "wholeSeconds": full_details["duration"], "clipSeconds": clip_details["duration"], "sampleRate": 48000, "channels": 1, "codec": "pcm_s16le", "noAudio": "NO_AUDIO_STREAM", "badRange": "INVALID_RANGE"}))


if __name__ == "__main__":
    main()
