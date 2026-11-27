import React from 'react';
import {createRoot} from 'react-dom/client';
import {Tldraw,BaseBoxShapeUtil,HTMLContainer,T,createShapeId} from 'tldraw';
import 'tldraw/tldraw.css';
import {CoverNodeUtil} from '../components/canvas/cover-node';
import {storeLocalImage} from '../lib/local-video-store';
import {registerAsset} from '../lib/production-records';
import {useAcquiredMediaUrl} from '../components/canvas/media-hooks';
class TestImageUtil extends BaseBoxShapeUtil{
 static type='image-node';static props={w:T.number,h:T.number,name:T.string,src:T.string,assetId:T.string,naturalWidth:T.number,naturalHeight:T.number};
 getDefaultProps(){return {w:220,h:330,name:'',src:'',assetId:'',naturalWidth:512,naturalHeight:768};}
 component(shape){return <TestImage shape={shape} editor={this.editor}/>;}
 getIndicatorPath(shape){const p=new Path2D();p.rect(0,0,shape.props.w,shape.props.h);return p;}
}
function TestImage({shape,editor}){const url=useAcquiredMediaUrl(shape.props.src,true);return <HTMLContainer style={{width:shape.props.w,height:shape.props.h,background:'#222',color:'white'}}><div>{shape.props.name}</div><button onPointerDown={e=>e.stopPropagation()} onClick={()=>editor.deleteShape(shape.id)}>删除测试原图</button><img src={url} alt={shape.props.name} style={{width:220,height:280,objectFit:'contain'}}/></HTMLContainer>;}
async function mount(editor){
 for(const [i,name] of ['man','woman'].entries()){
  const blob=await(await fetch('/runtime/cover-acceptance-20261017/'+name+'.png')).blob(),src=await storeLocalImage(blob,name+'.png');
  const asset=await registerAsset({kind:'image',origin:'imported',filename:name+'-canvas.png',mimeType:'image/png',storageReference:src,sourceRunId:null,width:512,height:768});
  editor.createShape({id:createShapeId(),type:'image-node',x:40+260*i,y:100,props:{src,assetId:asset.assetId,name:i?'女主画布图片':'男主画布图片'}});
 }
 const id=createShapeId();editor.createShape({id,type:'cover-node',x:580,y:30,props:{w:540,h:780,docId:crypto.randomUUID()}});editor.select(id);editor.setCamera({x:0,y:0,z:1});
}
const container=document.getElementById('root');const root=createRoot(container);root.render(<div style={{position:'fixed',inset:0}}><Tldraw shapeUtils={[TestImageUtil,CoverNodeUtil]} onMount={e=>void mount(e)}/></div>);
