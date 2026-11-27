import React, {useState, useEffect} from 'react';
import {createRoot} from 'react-dom/client';
import {Tldraw, PageRecordType, useValue} from 'tldraw';
import 'tldraw/tldraw.css';
import '../app/globals.css';
import {CanvasLibrary} from '../components/canvas/canvas-library';
import {RoleLibrary} from '../components/role-library';
import {AssetLibrary} from '../components/asset-library';
import {installCanvasLibraryScope} from '../lib/canvas-library-migration';
import {createRole} from '../lib/role-records';
import {registerAsset} from '../lib/production-records';
import {storeLocalImage} from '../lib/local-video-store';
const key='canvas-library-isolation-test-only';
async function image(name){
 const c=document.createElement('canvas');c.width=16;c.height=16;c.getContext('2d').fillRect(0,0,16,16);
 const blob=await new Promise(resolve=>c.toBlob(resolve,'image/png'));
 return registerAsset({kind:'image',origin:'imported',filename:name,mimeType:'image/png',storageReference:await storeLocalImage(blob,name),sourceRunId:null});
}
function Controls({editor}){
 const page=useValue('test-page',()=>editor.getCurrentPageId(),[editor]);
 const [panel,setPanel]=useState('');
 useEffect(()=>{queueMicrotask(()=>setPanel(''));},[page]);
 return <div style={{position:'absolute',inset:'0 0 auto',zIndex:1000,background:'white',padding:10}}><CanvasLibrary editor={editor} persistenceKey={key}/><button onClick={()=>setPanel('roles')}>测试角色库</button><button onClick={()=>setPanel('assets')}>测试素材库</button>{panel==='roles'&&<RoleLibrary onClose={()=>setPanel('')} onUpload={()=>{throw Error('test does not upload')}}/>}{panel==='assets'&&<AssetLibrary onClose={()=>setPanel('')} onPlace={async()=>{}} onImport={()=>{throw Error('test does not upload')}}/>}</div>;
}
function App(){
 const [editor,setEditor]=useState(null);
 return <div style={{position:'fixed',inset:0}}><Tldraw persistenceKey={key} onMount={e=>{void(async()=>{
  await installCanvasLibraryScope(e);
  if(!sessionStorage.getItem('seeded')){
   e.updatePage({id:e.getCurrentPageId(),name:'验收画布A'});await createRole('A专属角色');await image('A专属图片.png');
   const id=PageRecordType.createId();e.createPage({id,name:'验收画布B'});e.setCurrentPage(id);await createRole('B专属角色');await image('B专属图片.png');
   e.setCurrentPage(e.getPages().find(p=>p.name==='验收画布A').id);sessionStorage.setItem('seeded','1');
  }
  setEditor(e);
 })().catch(error=>{document.body.textContent='SMOKE ERROR '+error.message;});}}/>{editor&&<Controls editor={editor}/>}</div>;
}
createRoot(document.getElementById('root')).render(<App/>);
