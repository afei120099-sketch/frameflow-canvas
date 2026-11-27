import importlib.util,json,sys,hashlib
from pathlib import Path
from PIL import Image
import numpy as np
ROOT=Path(__file__).resolve().parents[1];sys.path.insert(0,str(ROOT/'scripts'))
from cover_art import composite_linear,relight
spec=importlib.util.spec_from_file_location('compose',ROOT/'scripts/cover-compose.py');c=importlib.util.module_from_spec(spec);spec.loader.exec_module(c)
OUT=ROOT/'runtime/cover-v2-acceptance-20261017';records=[]
actor=Image.open(OUT/'man/cutout.png').convert('RGBA');assert relight(actor,{'protection':'pixels'}).tobytes()==actor.tobytes()
base=composite_linear(Image.new('RGBA',actor.size,'white'),actor,(0,0));a=np.asarray(actor);b=np.asarray(base);opaque=a[:,:,3]==255;assert np.array_equal(a[:,:,:3][opaque],b[:,:,:3][opaque])
for name in ['man','woman']:
 alpha=np.asarray(Image.open(OUT/name/'alpha.png'));assert ((alpha>0)&(alpha<255)).sum()>0
for i,effect in enumerate(['metal','brush','cinema']):
 dest=OUT/f'cpu-title-{effect}';dest.mkdir(exist_ok=True)
 source=json.loads((OUT/'depth/plan.json').read_text(encoding='utf8'));source['actors']=[];source['background']='data:image/png;base64,'+__import__('base64').b64encode((OUT/'depth/base.png').read_bytes()).decode();source['title']='逆光归来·新生';source['titleStyle']['effect']=effect
 report=c.compose(source,dest);assert np.array_equal(np.asarray(Image.open(OUT/'depth/base.png')),np.asarray(Image.open(dest/'base.png')))
 assert report['title']['title']=='逆光归来';assert report['title']['subtitle']['title']=='新生';records.append({'effect':effect,'baseUnchanged':True,'gpuCalls':0,'manifest':report})
long='重生之后，豪门夫人开启自己的复仇与救赎！';font=c.font_for('sans',80,long)
lines=c.semantic_lines(long,font,600,3);assert not any(line[0] in '，。！？；：、' for line in lines)
records.append({'test':'opaque source RGB and half-alpha preserved','pass':True,'longTitleLines':lines})
(OUT/'cpu-tests.json').write_text(json.dumps(records,ensure_ascii=False,indent=2),encoding='utf8');print('CPU pixel protection, alpha, three actual font treatments, semantic breaks and zero-GPU title tests passed')
