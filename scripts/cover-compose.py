"""Local CPU cover compositor. No downloads, model loading, or source modification."""
import base64, io, json, math, sys, re, os
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parent))
import numpy as np
import cv2
from PIL import Image, ImageOps, ImageDraw, ImageFont, ImageFilter, ImageChops
from fontTools.ttLib import TTFont
from cover_art import decontaminate,relight,composite_linear,semantic_lines,bevel

def system_font(kind):
    configured = os.environ.get('FRAMEFLOW_COVER_FONT_' + kind.upper())
    candidates = [Path(configured)] if configured else []
    windows = Path(os.environ.get('WINDIR', 'C:/Windows')) / 'Fonts'
    names = ['NotoSerifSC-VF.ttf', 'simsun.ttc', 'msyh.ttc', 'simhei.ttf'] if kind == 'serif' else ['NotoSansSC-VF.ttf', 'msyh.ttc', 'simhei.ttf', 'simsun.ttc']
    candidates += [windows / name for name in names]
    candidates += [Path('/usr/share/fonts/opentype/noto') / ('NotoSerifCJK-Regular.ttc' if kind == 'serif' else 'NotoSansCJK-Regular.ttc'), Path('/System/Library/Fonts/PingFang.ttc')]
    return next((p for p in candidates if p.is_file()), None)

FONTS={'sans':system_font('sans'),'serif':system_font('serif'),'brush':Path(__file__).resolve().parents[1]/'runtime/cover-v2/fonts/MaShanZheng-Regular.ttf'}
def image(data):
    if not isinstance(data,str) or not data.startswith('data:image/') or ',' not in data: raise ValueError('图片必须为本地上传的图像数据')
    raw=base64.b64decode(data.split(',',1)[1],validate=True)
    with Image.open(io.BytesIO(raw)) as f:
        if f.width*f.height>32_000_000: raise ValueError('单张图片超过3200万像素，请先缩小')
        f=ImageOps.exif_transpose(f).convert('RGBA');f.thumbnail((4096,4096));return f
def faces(img,min_size=35):
    rgb=np.asarray(img.convert('RGB'));scale=min(1,1000/img.width)
    small=cv2.resize(rgb,None,fx=scale,fy=scale) if scale<1 else rgb
    classifier=Path(cv2.data.haarcascades)/'haarcascade_frontalface_default.xml'
    if not classifier.is_file():classifier=Path(sys.prefix)/'Lib/site-packages/skimage/data/lbpcascade_frontalface_opencv.xml'
    if not classifier.is_file():raise ValueError('本机缺少人脸检测数据，未自动下载；请先配置检测器')
    cascade=cv2.CascadeClassifier(str(classifier))
    if cascade.empty():
        from skimage.feature import Cascade
        found=Cascade(str(classifier)).detect_multi_scale(small,scale_factor=1.15,step_ratio=1.2,min_size=(min_size,min_size),max_size=(min(small.shape[:2]),)*2,min_neighbor_number=12,intersection_score_threshold=.5)
        boxes=sorted([[round(b[k]/scale) for k in ('c','r','width','height')] for b in found],key=lambda b:b[2]*b[3],reverse=True)
        unique=[]
        for box in boxes:
            if all(box_overlap(box,b)<min(box[2]*box[3],b[2]*b[3])*.6 for b in unique):unique.append(box)
        return unique
    found=cascade.detectMultiScale(cv2.cvtColor(small,cv2.COLOR_RGB2GRAY),scaleFactor=1.08,minNeighbors=5,minSize=(35,35))
    return [[round(v/scale) for v in box] for box in found]
def legacy_cutout(img):
    rgb=np.asarray(img.convert('RGB'));found=faces(img)
    if len(found)!=1: raise ValueError(f'自动抠图需要一张清晰单人正脸照片，检测到{len(found)}张脸；请更换主参考，或上传已抠好透明PNG')
    x,y,w,h=found[0];H,W=rgb.shape[:2]
    alpha=np.asarray(img.getchannel('A'))
    if alpha.min()<20 and np.mean(alpha<128)>.05:
        mask=alpha.copy();method='uploaded-transparent-png'
    else:
        # Conservative face-guided GrabCut. It is NOT a semantic human segmentation model.
        labels=np.full((H,W),cv2.GC_BGD,np.uint8)
        left=max(1,int(x-w*.95));right=min(W-1,int(x+w*1.95));top=max(1,int(y-h*.6))
        labels[top:H-1,left:right]=cv2.GC_PR_BGD
        cx=x+w/2
        poly=np.array([[cx-w*.66,top],[cx+w*.66,top],[cx+w*.82,y+h*1.2],[min(W-2,cx+w*1.6),H-2],[max(1,cx-w*1.6),H-2],[cx-w*.82,y+h*1.2]],np.int32)
        cv2.fillPoly(labels,[poly],cv2.GC_PR_FGD)
        cv2.ellipse(labels,(int(cx),int(y+h*.54)),(max(1,int(w*.32)),max(1,int(h*.36))),0,0,360,cv2.GC_FGD,-1)
        cv2.grabCut(rgb,labels,None,np.zeros((1,65)),np.zeros((1,65)),5,cv2.GC_INIT_WITH_MASK)
        mask=np.where((labels==cv2.GC_FGD)|(labels==cv2.GC_PR_FGD),255,0).astype(np.uint8)
        # Keep only the foreground component containing the face.
        _,components=cv2.connectedComponents(mask);label=components[min(H-1,int(y+h*.5)),min(W-1,int(cx))]
        if label==0: raise ValueError('抠图未能保留面部，请换清晰主参考或透明PNG')
        mask=np.where(components==label,mask,0).astype(np.uint8);method='face-guided-grabcut'
    coverage=float(np.mean(mask>128));face_coverage=float(np.mean(mask[y:y+h,x:x+w]>128))
    if not .04<coverage<.94 or face_coverage<.86: raise ValueError('自动抠图质量检查未通过：人物区域或面部不完整。请改用透明PNG，未生成封面')
    # Feather silhouette only; preserve original RGB and opaque face pixels.
    soft=np.asarray(Image.fromarray(mask).filter(ImageFilter.GaussianBlur(.65))).copy()
    soft[y:y+h,x:x+w]=mask[y:y+h,x:x+w]
    out=img.copy();out.putalpha(Image.fromarray(soft))
    return out,{'method':method,'face':found[0],'coverage':coverage,'faceCoverage':face_coverage,'requiresVisualReview':method!='uploaded-transparent-png','warning':'传统抠图不保证复杂头发、道具与背景分离，请检查透明图层边缘' if method!='uploaded-transparent-png' else ''}
def cutout(img,plan,out):
    found=faces(img);alpha=img.getchannel('A');metrics={}
    if plan.get('alpha'):
        alpha=image(plan['alpha']).convert('L')
        if alpha.size!=img.size:raise ValueError('人工遮罩必须与原图同尺寸')
        method='manual-alpha'
    elif np.mean(np.asarray(alpha)<128)>.05:method='uploaded-transparent-png'
    elif plan.get('mattingMethod')=='grabcut':
        legacy,report=legacy_cutout(img);alpha=legacy.getchannel('A');method=report['method']
    else:
        from cover_matting import predict
        alpha,metrics=predict(img,'cpu');method='BiRefNet-matting'
    coverage=float(np.mean(np.asarray(alpha)>128))
    if not .02<coverage<.98:raise ValueError('抠图前景范围异常；请人工补边或上传透明PNG，未自动回退到GrabCut')
    alpha.save(out/'alpha.png')
    clean=decontaminate(img,alpha) if method=='BiRefNet-matting' else img.convert('RGB')
    result=clean.convert('RGBA');result.putalpha(alpha)
    raw=img.copy();raw.putalpha(alpha);raw.save(out/'raw-cutout.png')
    for name,color in [('black',0),('white',255),('gray',128)]:
        bg=Image.new('RGBA',img.size,(color,color,color,255));bg.alpha_composite(result);bg.save(out/f'check-{name}.png')
    return result,{'method':method,'face':found[0] if len(found)==1 else [],'faces':found,'coverage':coverage,'metrics':metrics,'requiresVisualReview':True,'warning':'请检查发丝和衣领；无可靠正脸时请人工核对标题避让区域','files':['cutout.png','raw-cutout.png','alpha.png','check-black.png','check-white.png','check-gray.png']}
def box_overlap(a,b):
    return max(0,min(a[0]+a[2],b[0]+b[2])-max(a[0],b[0]))*max(0,min(a[1]+a[3],b[1]+b[3])-max(a[1],b[1]))
def font_for(key,size,title):
    if key not in FONTS or FONTS[key] is None or not FONTS[key].is_file():raise ValueError('找不到中文字体；请配置 FRAMEFLOW_COVER_FONT_SANS / FRAMEFLOW_COVER_FONT_SERIF')
    table=TTFont(str(FONTS[key]),lazy=True, **({'fontNumber':0} if FONTS[key].suffix.lower() == '.ttc' else {}));cmap=table.getBestCmap();missing=[c for c in title if not c.isspace() and ord(c) not in cmap];table.close()
    if missing:raise ValueError('字体不支持这些字符：'+''.join(dict.fromkeys(missing)))
    font=ImageFont.truetype(str(FONTS[key]),size)
    if hasattr(font,'set_variation_by_axes'):
        try:font.set_variation_by_axes([800])
        except (OSError,ValueError):pass
    return font
def title_layer(size,title,settings,face_boxes,base):
    W,H=size
    if not isinstance(title,str) or not title.strip() or len(title)>120:raise ValueError('剧名需为1～120字符')
    effect=settings.get('effect','gold');layout=settings.get('layout','auto');tracking=float(settings.get('tracking',2));leading=float(settings.get('lineHeight',1.15))
    factor=float(settings.get('size',1));factor=max(.3,min(2,factor));leading=max(1,min(2,leading));tracking=max(-2,min(15,tracking))
    vertical=layout in ('vertical','left','right');fontkey=settings.get('font','sans')
    if effect=='brush':fontkey='brush'
    margin=int(W*.025);maxw=int(W*.86);maxh=int(H*.34)
    zone=settings.get('zone')
    if zone:
        from cover_director_art import rect
        zx,zy,zx2,zy2=rect(zone,W,H);maxw=zx2-zx-32;maxh=zy2-zy-32
        if maxw<30 or maxh<30:raise ValueError('标题预留空间过小')
    def measure(line,font):return sum(font.getlength(c) for c in line)+max(0,len(line)-1)*tracking
    lines=[]
    for fs in range(max(24,int(W*.14*factor)),23,-2):
        font=font_for(fontkey,fs,title);lines=[]
        for paragraph in title.split('\n'):
            line='';paragraph_lines=[]
            for char in paragraph:
                if line and (not vertical and measure(line+char,font)>maxw or vertical and len(line)>=max(1,int(maxh/(fs*leading)))):paragraph_lines.append(line);line=''
                line+=char
            paragraph_lines.append(line)
            if not vertical:paragraph_lines=semantic_lines(paragraph,font,maxw,tracking)
            lines.extend(paragraph_lines)
        tw=math.ceil(max((measure(line,font) for line in lines),default=0))
        th=int(len(lines)*fs*leading+fs*.25)
        if vertical:tw=int(len(lines)*fs*leading);th=int(max(map(len,lines))*fs*leading)
        if tw<=maxw and (th<=maxh or not zone and vertical and th<H*.65):break
    if tw>maxw or th>H*.7 or zone and th>maxh:raise ValueError('剧名过长，无法安全排版，请缩小字号或调整标题')
    pad=max(10,int(fs*.12));tw+=pad*2;th+=pad*2
    def candidate(cx,cy):return [max(margin,min(W-margin-tw,int(cx*W-tw/2))),max(margin,min(H-margin-th,int(cy*H-th/2))),tw,th]
    choices=[candidate(.5,.81),candidate(.5,.14),candidate(.5,.91),candidate(.5,.60)]
    if layout=='manual':choices=[candidate(float(settings.get('x',.5)),float(settings.get('y',.78)))]
    elif layout=='top':choices=[candidate(.5,.14)]
    elif layout=='bottom':choices=[candidate(.5,.84)]
    elif vertical:choices=[candidate(.18,.5),candidate(.82,.5)]
    if zone:choices=[[zx+(zx2-zx-tw)//2,zy+(zy2-zy-th)//2,tw,th]]
    safe=[b for b in choices if all(box_overlap(b,f)==0 for f in face_boxes)]
    if not safe:raise ValueError('标题会遮挡面部，请调整人物位置、标题位置或缩小字号；未覆盖上一版本')
    def score(b):
        crop=np.asarray(base.convert('L').crop((b[0],b[1],b[0]+b[2],b[1]+b[3])))
        return float(crop.mean())*.02+abs(b[1]+b[3]/2-H*.82)/H
    x,y,_,_=min(safe,key=score)
    mask=Image.new('L',size);d=ImageDraw.Draw(mask)
    for row,line in enumerate(lines):
        xx=x+pad+(0 if vertical else (tw-pad*2-measure(line,font))/2);yy=y+pad+row*fs*leading
        for col,char in enumerate(line):
            if vertical:xx=x+pad+row*fs*leading;yy=y+pad+col*fs*leading
            d.text((int(xx),int(yy)),char,font=font,fill=255,anchor='lt',stroke_width=1 if effect=='brush' else 0)
            if not vertical:xx+=font.getlength(char)+tracking
    arr=np.asarray(mask);stroke=mask.filter(ImageFilter.MaxFilter(5));shadow=Image.new('RGBA',size)
    shadowalpha=ImageOps.expand(mask,border=0).filter(ImageFilter.GaussianBlur(9 if effect=='glow' else 4))
    shadow.paste((30,16,3,240),(0,0,W,H),shadowalpha)
    if effect=='glow':shadow.paste((58,180,255,255),(0,0,W,H),shadowalpha.filter(ImageFilter.GaussianBlur(12)))
    shadow.paste((14,12,16,255),(0,0,W,H),stroke)
    colors={'gold':[(255,245,188),(125,75,18),(255,214,112)],'metal':[(244,250,255),(75,88,109),(236,242,250)],'brush':[(250,240,215),(208,193,158),(255,248,229)],'cinema':[(252,250,241)]*3,'glow':[(240,255,255),(132,226,255),(245,255,255)]}[effect]
    yy=np.clip((np.arange(H)-y)/max(1,th),0,1);rgb=np.zeros((H,W,4),np.uint8)
    for channel in range(3):rgb[:,:,channel]=np.interp(yy,[0,.5,1],[c[channel] for c in colors])[:,None]
    rgb[:,:,3]=arr
    layer=Image.alpha_composite(shadow,Image.fromarray(rgb))
    if effect in ('gold','metal'):layer=Image.alpha_composite(shadow,bevel(mask,effect,settings.get('lightDirection','left')))
    return layer,{'title':title,'lines':lines,'font':fontkey,'fontSize':fs,'box':[x,y,tw,th],'faceOverlap':0,'effect':effect,'fontLicense':'SIL OFL 1.1','fontFamily':'Ma Shan Zheng' if fontkey=='brush' else 'Noto '+fontkey}
def compose(plan,out):
    W,H=map(int,plan.get('size',[1080,1920]))
    if (W,H) not in [(1080,1920),(1080,1440),(1080,1080)]:raise ValueError('封面尺寸只支持1080×1920、1080×1440、1080×1080')
    background=image(plan['background']);base=ImageOps.fit(background,(W,H),method=Image.Resampling.LANCZOS)
    fusion=plan.get('fusion',{})
    if plan.get('actors') and fusion.get('depth',True):base=base.filter(ImageFilter.GaussianBlur(1.2))
    face_boxes=[];actors=plan.get('actors',[])
    if len(actors)>9:raise ValueError('人物超过9个')
    protection=Image.new('L',(W,H));actor_meta=[]
    for actor in sorted(actors,key=lambda a:float(a.get('z',0))):
        source=image(actor['image']);source=relight(source,fusion);scale=max(.1,min(1.5,float(actor.get('scale',.78))))
        # V2 visual weight must remain effective: the V1 width cap made most scale values identical.
        factor=min(H*(.72 if 'fusion' in plan else 1)*scale/source.height,W*(1.12 if 'fusion' in plan else .92)/source.width)
        w,h=max(1,round(source.width*factor)),max(1,round(source.height*factor));resized=source.resize((w,h),Image.Resampling.LANCZOS)
        x=round(float(actor.get('x',.5))*W-w/2);y=round(float(actor.get('y',.73))*H-h)
        alpha=resized.getchannel('A')
        # No artificial full-silhouette drop shadow on a half-body portrait.
        shadow=Image.new('RGBA',(W,H));sd=ImageDraw.Draw(shadow)
        if actor.get('fullBody'):
            sd.ellipse((x+w*.22,y+h-12,x+w*.85,y+h+16),fill=(5,8,12,100))
            shadow=shadow.filter(ImageFilter.GaussianBlur(9))
        elif fusion.get('protection','pixels')!='pixels' and np.asarray(protection).max():
            cast=Image.new('L',(W,H));offset=5 if fusion.get('lightDirection','left')=='left' else -5
            cast.paste(alpha,(x+offset,y+3));cast=ImageChops.multiply(cast.filter(ImageFilter.GaussianBlur(5)),protection)
            shadow.putalpha(cast.point(lambda v:round(v*.18)))
        base=Image.alpha_composite(base,shadow)
        base=composite_linear(base,resized,(x,y))
        placed=Image.new('L',(W,H));placed.paste(alpha,(x,y));protection=ImageChops.lighter(protection,placed)
        face=actor.get('face')
        if face:face_boxes.append([round(x+face[0]*factor),round(y+face[1]*factor),round(face[2]*factor),round(face[3]*factor)])
        actor_meta.append({k:actor.get(k) for k in ['role','x','y','scale','z']})
    if not actors:
        original_boxes=plan.get('faceBoxes')
        if original_boxes:
            fit=max(W/background.width,H/background.height);dx=(background.width*fit-W)/2;dy=(background.height*fit-H)/2
            face_boxes=[[round(f[0]*fit-dx),round(f[1]*fit-dy),round(f[2]*fit),round(f[3]*fit)] for f in original_boxes]
        else:face_boxes=faces(base)
    # Face detection is conservative. If no face is detected in a redraw, expose review warning.
    warnings=[]
    if not face_boxes:warnings.append('未可靠检测面部，标题位置需要人工核对')
    for f in face_boxes:
        if f[0]<0 or f[1]<0 or f[0]+f[2]>W or f[1]+f[3]>H:raise ValueError('人物面部超出画布，请调整位置或大小')
    if actors:
        # A face may not be hidden by another actor's face; retain all requested roles.
        fit=max(W/background.width,H/background.height);dx=(background.width*fit-W)/2;dy=(background.height*fit-H)/2
        background_faces=[[round(b[0]*fit-dx),round(b[1]*fit-dy),round(b[2]*fit),round(b[3]*fit)] for b in faces(background)]
        unexpected=[b for b in background_faces if not plan.get('allowBackgroundCast') or not any(box_overlap(b,f)>min(b[2]*b[3],f[2]*f[3])*.3 for f in face_boxes)]
        if unexpected and not plan.get('allowBackgroundCast'):raise ValueError('背景中检测到额外人物面部，请重新生成无人背景；未接受错误人物数量')
        if unexpected:warnings.append('修复后背景检测到疑似新增面部（可能误报），请人工核对人数，尚未验收合格')
        for i,f in enumerate(face_boxes):
            if any(box_overlap(f,b)>min(f[2]*f[3],b[2]*b[3])*.1 for b in face_boxes[i+1:]):raise ValueError('人物面部互相遮挡，请减小人物或调整横向位置')
    # Low amplitude unified grain, masked away from opaque source pixels in pixel-protection mode.
    if actors and fusion.get('grain',True):
        b=np.asarray(base).copy();noise=np.random.default_rng(73).normal(0,.5,(H,W,1))
        if fusion.get('protection','pixels')=='pixels':noise=noise*(1-np.asarray(protection)[:,:,None]/255)
        b[:,:,:3]=np.uint8(np.clip(b[:,:,:3].astype(float)+noise,0,255));base=Image.fromarray(b)
    base.save(out/'base.png')
    # Repair only an outer silhouette seam, not the entire background: avoid inventing a new cast.
    repair_mask=ImageChops.subtract(protection.filter(ImageFilter.MaxFilter(41)),protection.filter(ImageFilter.MaxFilter(5)))
    repair_mask.save(out/'repair-mask.png')
    title_text=plan['title'];subtitle=plan.get('subtitle','')
    if '·' in title_text and not subtitle:title_text,subtitle=[p.strip() for p in title_text.split('·',1)]
    ts={**plan.get('titleStyle',{}),'lightDirection':fusion.get('lightDirection','left')}
    subtitle_zone=None
    if subtitle and ts.get('zone'):
        x,y,w,h=ts['zone']
        if ts.get('layout') in ('vertical','left','right'):
            ts['zone']=[x,y,w*.66,h];subtitle_zone=[x+w*.70,y,w*.30,h]
        else:
            ts['zone']=[x,y,w,h*.67];subtitle_zone=[x,y+h*.72,w,h*.28]
    title,meta=title_layer((W,H),title_text,ts,face_boxes,base)
    if subtitle:
        subsettings={**ts,'size':float(ts.get('size',1))*.38,'layout':'manual','x':.5,'y':min(.94,(meta['box'][1]+meta['box'][3])/H+.035),'effect':'cinema'}
        subsettings.pop('zone',None)
        if subtitle_zone:subsettings.update({'zone':subtitle_zone,'layout':ts.get('layout','bottom')})
        sub,submeta=title_layer((W,H),subtitle,subsettings,face_boxes,base);title=Image.alpha_composite(title,sub);meta['subtitle']=submeta
    title.save(out/'title.png');Image.alpha_composite(base,title).save(out/'final.png')
    manifest={'version':'cover-v2.0','size':[W,H],'title':meta,'actors':actor_meta,'faces':face_boxes,'fusion':fusion,'warnings':warnings,'files':['base.png','title.png','final.png','repair-mask.png']}
    (out/'manifest.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2),encoding='utf8');return manifest
def main():
    sys.stdout.reconfigure(encoding='utf-8');sys.stderr.reconfigure(encoding='utf-8')
    plan=json.loads(Path(sys.argv[1]).read_text(encoding='utf8'));out=Path(sys.argv[2]);out.mkdir(exist_ok=True,parents=True)
    if plan.get('operation')=='cutout':
        result,report=cutout(image(plan['image']),plan,out);result.save(out/'cutout.png');report.update({'size':list(result.size)});report.setdefault('files',['cutout.png']);(out/'manifest.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf8')
    elif plan.get('operation') in ('director-guide','identity-cards'):
        from cover_director_art import execute
        report=execute(plan,out,image,faces)
    else:report=compose(plan,out)
    print(json.dumps(report,ensure_ascii=False),flush=True)
if __name__=='__main__':
    try:main()
    except Exception as error:
        print(json.dumps({'error':str(error)},ensure_ascii=False),file=sys.stderr,flush=True);sys.exit(1)
