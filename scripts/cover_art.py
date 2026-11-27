"""Non-destructive CPU art controls. No generative model, download or GPU call."""
import math, re
import numpy as np
import cv2
from PIL import Image, ImageFilter, ImageDraw

def decontaminate(img,alpha):
    rgb=np.asarray(img.convert('RGB')).astype(np.float32); a=np.asarray(alpha).astype(np.float32)/255
    # Extend real foreground colors only into the uncertain band, never shrink hair alpha.
    core=(a>.97).astype(np.uint8)
    if not core.any():return img.convert('RGB')
    _,labels=cv2.distanceTransformWithLabels(1-core,cv2.DIST_L2,5,labelType=cv2.DIST_LABEL_PIXEL)
    palette=np.zeros((int(labels.max())+1,3),np.float32);palette[labels[core>0]]=rgb[core>0]
    nearest=palette[labels]
    weight=np.clip((.96-a)*1.6,0,.85)*(a>.015)
    clean=rgb*(1-weight[:,:,None])+nearest*weight[:,:,None]
    return Image.fromarray(np.uint8(np.clip(clean,0,255)))

def relight(img,settings):
    # Pixel mode has no color/shape edits. Identity mode is a reversible color grade, not neural relighting.
    if settings.get('protection','pixels')=='pixels':return img
    arr=np.asarray(img).astype(np.float32)/255;h,w=arr.shape[:2]
    warmth=max(-.15,min(.15,float(settings.get('warmth',.025))))
    exposure=max(-.5,min(.5,float(settings.get('exposure',-.06))))
    direction=settings.get('lightDirection','left')
    ramp=np.linspace(1,0,w) if direction=='left' else np.linspace(0,1,w)
    strength=max(0,min(.15,float(settings.get('lightStrength',.065))))
    arr[:,:,:3]*=(2**exposure)*(1-strength+2*strength*ramp[None,:,None])
    arr[:,:,:3]*=np.array([1+warmth,1,1-warmth])
    return Image.fromarray(np.uint8(np.clip(arr,0,1)*255))

def composite_linear(base,actor,xy):
    layer=Image.new('RGBA',base.size);layer.alpha_composite(actor,xy)
    b=np.asarray(base).astype(np.float32)/255;s=np.asarray(layer).astype(np.float32)/255
    a=s[:,:,3:4]
    def linear(x):return np.where(x<=.04045,x/12.92,((x+.055)/1.055)**2.4)
    c=linear(s[:,:,:3])*a+linear(b[:,:,:3])*(1-a)
    rgb=np.where(c<=.0031308,c*12.92,1.055*np.maximum(c,0)**(1/2.4)-.055)
    rgb=np.where(a>=1,s[:,:,:3],rgb)
    return Image.fromarray(np.concatenate([np.uint8(np.rint(np.clip(rgb,0,1)*255)),np.full((*a.shape[:2],1),255,np.uint8)],2),'RGBA')

def semantic_lines(text,font,max_width,tracking):
    """Bounded dynamic programming: punctuation and known phrase boundaries beat even character counts."""
    phrases=['重生之后','逆光归来','自己的','救赎','归来','新生','复仇','总裁','夫人','豪门','一分钟']
    n=len(text)
    def width(t):return sum(font.getlength(c) for c in t)+max(0,len(t)-1)*tracking
    boundaries=set()
    for phrase in phrases:
        for m in re.finditer(re.escape(phrase),text):boundaries.update([m.start(),m.end()])
    dp=[(0,[])]+[(float('inf'),[]) for _ in range(n)]
    for end in range(1,n+1):
        for start in range(end):
            part=text[start:end];w=width(part)
            if w>max_width or n>1 and len(part)==1 or part[0] in '，。！？；：、·）》】' or part[-1] in '（《【·':continue
            if start and dp[start][0]==float('inf'):continue
            cost=((max_width-w)/max_width)**2+(.8 if len(part)==1 else 0)+(.3 if end<n and end not in boundaries else 0)
            if dp[start][0]+cost<dp[end][0]:dp[end]=(dp[start][0]+cost,dp[start][1]+[part])
    return dp[n][1] or [text]

def bevel(mask,color='gold',direction='left'):
    a=np.asarray(mask);dist=cv2.distanceTransform((a>127).astype(np.uint8),cv2.DIST_L2,5)
    bevel=np.minimum(dist,3.5);gy,gx=np.gradient(bevel);sign=1 if direction=='left' else -1
    light=np.clip((sign*gx-gy)*.17+.60,.18,1.05)
    top=np.array([239,216,153] if color=='gold' else [210,222,235]);rgb=light[:,:,None]*top
    # Restrained variation, not plastic full-width black/gold stripes.
    rgb+=np.sin(np.arange(a.shape[0])[:,None,None]*.015)*3
    return Image.fromarray(np.dstack((np.uint8(np.clip(rgb,0,255)),a)),'RGBA')
