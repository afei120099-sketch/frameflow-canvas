"""V2.1 anonymous layout guides and manual identity contact sheets. CPU only.
No OCR or identity recognition is claimed. Planned face crops are not detected identities.
"""
import json
from PIL import Image, ImageDraw, ImageOps

def rect(box,w,h):
    x,y,bw,bh=box
    if any(not isinstance(v,(int,float)) or not 0<=v<=1 for v in box) or bw<=0 or bh<=0 or x+bw>1.001 or y+bh>1.001:
        raise ValueError('构图区域越界')
    return (round(x*w),round(y*h),round((x+bw)*w),round((y+bh)*h))

def execute(plan,out,decode,detect):
    if plan['operation']=='director-guide':
        p=plan['directorPlan'];w,h=576,1024
        if not 1<=len(p['actors'])<=2:raise ValueError('构图参考只支持1～2个身份')
        canvas=Image.new('RGB',(w,h),(28,33,43));d=ImageDraw.Draw(canvas)
        d.polygon([(0,0),(w,0),(int(w*.52),int(h*.72))],fill=(63,68,77))
        for i,a in enumerate(sorted(p['actors'],key=lambda a:a['depth'])):
            x,y,x2,y2=rect(a['box'],w,h);hx,hy,hx2,hy2=rect(a['head'],w,h)
            color=(130,140,151) if i==0 else (177,170,160)
            d.polygon([(hx,hy2),(hx2,hy2),(x2,y2),(x,y2)],fill=color)
            d.ellipse((hx,hy,hx2,hy2),fill=color)
        # An optional evidence placeholder is deliberately not a fabricated specific object.
        if p.get('evidence'):d.ellipse((w*.37,h*.68,w*.62,h*.78),fill=(166,153,116))
        d.rectangle(rect(p['title']['zone'],w,h),fill=(19,23,30))
        canvas.save(out/'guide.png')
        report={'size':[w,h],'files':['guide.png'],'anonymous':True,'text':False,'identityAuthority':False,'directorPlan':p}
    else:
        if not isinstance(plan.get('roles'),list) or not 1<=len(plan['roles'])<=2:raise ValueError('身份检查卡只支持1～2个角色')
        generated=decode(plan['generated']);cards=[];files=[]
        for i,role in enumerate(plan['roles'],1):
            source=decode(role['image']);found=detect(source)
            original=source.crop((found[0][0],found[0][1],found[0][0]+found[0][2],found[0][1]+found[0][3])) if found else source
            region=rect(role['head'],generated.width,generated.height)
            names=[f'original-face-{i}.png',f'generated-face-{i}.png']
            ImageOps.contain(original,(360,360)).save(out/names[0]);ImageOps.contain(generated.crop(region),(360,360)).save(out/names[1]);files+=names
            cards.append({'roleId':role['roleId'],'originalFile':names[0],'generatedFile':names[1],'cropMethod':'original detector or full-reference fallback; generated PLANNED region, manually verify/correct; NOT identity recognition'})
        report={'size':list(generated.size),'files':files,'cards':cards,'ocr':'unavailable-unvalidated; manual full-image check required','identityRecognition':False}
    (out/'manifest.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf8')
    return report
