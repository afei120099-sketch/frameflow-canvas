"""CPU acceptance with actual V1 references and separately saved generated backgrounds."""
import base64,importlib.util,json,sys,time
from pathlib import Path
from PIL import Image,ImageDraw,ImageOps
ROOT=Path(__file__).resolve().parents[1];OUT=ROOT/'runtime/cover-v2-acceptance-20261017';OUT.mkdir(parents=True,exist_ok=True)
sys.path.insert(0,str(ROOT/'scripts'))
spec=importlib.util.spec_from_file_location('compose',ROOT/'scripts/cover-compose.py');c=importlib.util.module_from_spec(spec);spec.loader.exec_module(c)
def uri(p):return 'data:image/png;base64,'+base64.b64encode(Path(p).read_bytes()).decode()
cuts=[]
for name in ['man','woman']:
    dest=OUT/name;dest.mkdir(exist_ok=True)
    img=Image.open(ROOT/f'runtime/cover-acceptance-20261017/{name}.png').convert('RGBA')
    if not (dest/'manifest.json').exists():
        cut,report=c.cutout(img,{'mattingMethod':'birefnet'},dest);cut.save(dest/'cutout.png');(dest/'manifest.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf8')
    report=json.loads((dest/'manifest.json').read_text(encoding='utf8'));cuts.append((dest/'cutout.png',report['face']))
records=json.loads((OUT/'a-gpu-records.json').read_text())['records'];results=[]
for i,record in enumerate(records):
    dest=OUT/record['template'];dest.mkdir(exist_ok=True)
    actors=[dict(a,image=uri(cuts[j][0]),face=cuts[j][1]) for j,a in enumerate(record['actors'])]
    plan={'operation':'compose','size':[1080,1920],'background':uri(record['background']),'actors':actors,'title':'逆光归来','titleStyle':{'font':'sans','effect':['metal','brush','cinema'][i],'layout':'bottom','size':1,'lineHeight':1.12,'tracking':3},'fusion':{'protection':'identity' if i==1 else 'pixels','lightDirection':'right' if i==2 else 'left','warmth':.025,'exposure':-.06,'grain':True,'depth':True}}
    start=time.perf_counter()
    try:report=c.compose(plan,dest);results.append({'template':record['template'],'status':'output-generated','seconds':time.perf_counter()-start,'manifest':report})
    except Exception as e:results.append({'template':record['template'],'status':'FAIL','error':str(e)})
    (dest/'plan.json').write_text(json.dumps(plan,ensure_ascii=False),encoding='utf8')
(OUT/'a-cpu-results.json').write_text(json.dumps(results,ensure_ascii=False,indent=2),encoding='utf8')
# Visual evidence: original V1 and the actual V2 outputs, no simulated previews.
files=[ROOT/'runtime/cover-acceptance-20261017/preserve-candidate-1.png']+[OUT/r['template']/'final.png' for r in records]
sheet=Image.new('RGB',(4*360,680),'#171a23');draw=ImageDraw.Draw(sheet)
for i,p in enumerate(files):
    if p.exists():sheet.paste(ImageOps.contain(Image.open(p).convert('RGB'),(360,640)),(i*360,35))
    draw.text((i*360+10,10),['V1 A','V2 depth','V2 revenge','V2 crime'][i],fill='white')
sheet.save(OUT/'v1-v2-comparison.jpg',quality=94)
edge=Image.new('RGB',(6*256,420),'#171a23')
for j,name in enumerate(['man','woman']):
    for i,bg in enumerate(['black','white','gray']):edge.paste(ImageOps.contain(Image.open(OUT/name/f'check-{bg}.png').convert('RGB'),(256,384)),((j*3+i)*256,30))
edge.save(OUT/'edge-three-backgrounds.jpg',quality=95)
print(json.dumps(results,ensure_ascii=False),flush=True)
