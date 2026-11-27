import base64,importlib.util,json,sys
from pathlib import Path
from PIL import Image,ImageOps,ImageDraw
ROOT=Path(__file__).resolve().parents[1];sys.path.insert(0,str(ROOT/'scripts'));OUT=ROOT/'runtime/cover-v2-acceptance-20261017'
spec=importlib.util.spec_from_file_location('compose',ROOT/'scripts/cover-compose.py');c=importlib.util.module_from_spec(spec);spec.loader.exec_module(c)
results=[]
for i in [1,2,3,4]:
    source=OUT/f'klein/{i}-output.png' if i<4 else OUT/'klein/4-layout-output.png';dest=OUT/f'klein/{i}-final';dest.mkdir(exist_ok=True)
    plan={'operation':'compose','size':[1080,1920],'actors':[],'background':'data:image/png;base64,'+base64.b64encode(source.read_bytes()).decode(),'title':'逆光归来','titleStyle':{'font':'sans','effect':'cinema','layout':'bottom','size':1,'tracking':3,'lineHeight':1.12}}
    try:report=c.compose(plan,dest);results.append({'index':i,'status':'output-generated','manifest':report,'visualFailure':'模型生成了多余乱码文字，不能采用' if i==1 else ''})
    except Exception as e:results.append({'index':i,'status':'FAIL','error':str(e)})
(OUT/'klein/compose-records.json').write_text(json.dumps(results,ensure_ascii=False,indent=2),encoding='utf8')
paths=[ROOT/'runtime/cover-acceptance-20261017/preserve-candidate-1.png',ROOT/'runtime/cover-acceptance-20261017/redraw-candidate-1.png',OUT/'crime/final.png',OUT/'klein/2-final/final.png',OUT/'klein/4-final/final.png']
sheet=Image.new('RGB',(5*324,612),'#171a23');d=ImageDraw.Draw(sheet)
for i,p in enumerate(paths):
    if p.exists():sheet.paste(ImageOps.contain(Image.open(p).convert('RGB'),(324,576)),(324*i,30))
    d.text((324*i+8,8),['V1 A','V1 B Dev','V2 A','Klein 2 Chinese','Klein 4 + layout'][i],fill='white')
sheet.save(OUT/'v1-v2-klein-comparison.jpg',quality=95)
print(json.dumps(results,ensure_ascii=False))
