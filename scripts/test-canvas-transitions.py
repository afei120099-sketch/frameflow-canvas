"""Synthetic CPU-only transition and QC acceptance, never touches user media."""
import importlib.util
from pathlib import Path
import tempfile
import json
import av

def module(name,file):
    spec=importlib.util.spec_from_file_location(name,Path(__file__).parent/file)
    result=importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result

cut=module("cut","rough-cut.py")
fixtures=module("fixtures","rough-cut-fixtures.py")
audit=module("audit","media-audit.py")
with tempfile.TemporaryDirectory(prefix="frameflow-upgrade-test-") as temp:
    root=Path(temp)
    for i in range(2):
        fixtures.make_clip(root/f"{i}.mp4",320,180,24,2,40+i*100,(440,48000,"stereo"))
    for kind,expected in [("dissolve",90),("fade",96),("cut",96)]:
        plan={"sizePolicy":"first","clips":[{"source":str(root/f"{i}.mp4"),"inPoint":0,"outPoint":2,"title":str(i),"transition":{"type":kind,"seconds":0.25}} for i in range(2)]}
        file=root/"plan.json"
        file.write_text(json.dumps(plan),encoding="utf-8")
        facts=cut.run_plan(file)
        assert facts["output"]["frames"]==expected
        output=root/f"{kind}.mp4"
        rendered=cut.render(file,output)
        assert rendered["frames"]==expected
        result=audit.inspect(str(output))
        assert result["frames"]==expected
        assert result["hasAudio"]
        assert abs(result["decodedDuration"]-expected/24)<.002
        with av.open(str(output)) as stream:
            frames=list(stream.decode(video=0))
            assert len(frames)==expected
            pixel=frames[46].to_ndarray(format="rgb24").mean(axis=(0,1))
            if kind=="dissolve": assert 50<pixel[0]<135, pixel
        print("PASS",kind,expected,"frames",result["decodedDuration"],"seconds, audio decoded")
    print("PASS CPU transitions: exact frame count, overlap duration, blended pixels, audio and QC decode. No user media or GPU used.")

