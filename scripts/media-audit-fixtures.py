"""Small black-frame CPU fixture, only in the caller's temporary test directory."""
import sys
from pathlib import Path
import av
import numpy as np
from fractions import Fraction

with av.open(str(Path(sys.argv[1]) / "black.mp4"), "w") as out:
    stream = out.add_stream("libx264", rate=24)
    stream.width, stream.height, stream.pix_fmt = 64, 64, "yuv420p"
    for i in range(24):
        frame = av.VideoFrame.from_ndarray(np.zeros((64, 64, 3), dtype=np.uint8), format="rgb24")
        frame.pts, frame.time_base = i, Fraction(1, 24)
        for packet in stream.encode(frame):
            out.mux(packet)
    for packet in stream.encode():
        out.mux(packet)
