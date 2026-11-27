/** UI-only load shedding. Never pauses a render or changes task state. */
let interacting=false;
const listeners=new Set<()=>void>();
export const getCanvasInteracting=()=>interacting;
export function subscribeCanvasInteraction(listener:()=>void){listeners.add(listener);return()=>{listeners.delete(listener);};}
function publish(value:boolean){if(interacting===value)return;interacting=value;for(const listener of listeners)listener();}
export function bindCanvasInteraction(root:HTMLElement){
  let pointer:{id:number;x:number;y:number}|null=null;
  let timer:ReturnType<typeof setTimeout>|undefined;
  const set=(value:boolean)=>{root.classList.toggle('ff-canvas-interacting',value);publish(value);};
  const settle=()=>{clearTimeout(timer);timer=setTimeout(()=>set(false),160);};
  const down=(event:PointerEvent)=>{
    if(event.button!==0&&event.button!==1)return;
    const target=event.target as HTMLElement|null;
    if(target?.closest('button,input,textarea,select,a,video,audio,[contenteditable="true"],.h3-settings-panel,.tlui-toolbar'))return;
    pointer={id:event.pointerId,x:event.clientX,y:event.clientY};
  };
  const move=(event:PointerEvent)=>{if(pointer?.id===event.pointerId&&Math.hypot(event.clientX-pointer.x,event.clientY-pointer.y)>4){clearTimeout(timer);set(true);}};
  const up=(event:PointerEvent)=>{if(pointer?.id===event.pointerId){pointer=null;settle();}};
  const wheel=(event:WheelEvent)=>{if((event.target as HTMLElement|null)?.closest('input,textarea,select,.h3-settings-panel'))return;set(true);settle();};
  const blur=()=>{pointer=null;clearTimeout(timer);set(false);};
  root.addEventListener('pointerdown',down,true);
  root.addEventListener('wheel',wheel,{capture:true,passive:true});
  window.addEventListener('pointermove',move,{capture:true,passive:true});
  window.addEventListener('pointerup',up,true);window.addEventListener('pointercancel',up,true);window.addEventListener('blur',blur);
  return()=>{clearTimeout(timer);root.removeEventListener('pointerdown',down,{capture:true});root.removeEventListener('wheel',wheel,{capture:true});window.removeEventListener('pointermove',move,{capture:true});window.removeEventListener('pointerup',up,{capture:true});window.removeEventListener('pointercancel',up,{capture:true});window.removeEventListener('blur',blur);set(false);};
}
/** Only the active media gesture installs handlers, not every video on the canvas. */
export function observeMediaGesture(target:EventTarget,pointerId:number,move:(event:PointerEvent)=>void,finish:(event:PointerEvent)=>void,cancel:()=>void){
  const onMove=(event:Event)=>{const pointer=event as PointerEvent;if(pointer.pointerId===pointerId)move(pointer);};
  const onUp=(event:Event)=>{const pointer=event as PointerEvent;if(pointer.pointerId!==pointerId)return;detach();finish(pointer);};
  const onCancel=(event:Event)=>{if((event as PointerEvent).pointerId!==pointerId)return;detach();cancel();};
  const detach=()=>{target.removeEventListener('pointermove',onMove,{capture:true});target.removeEventListener('pointerup',onUp,{capture:true});target.removeEventListener('pointercancel',onCancel,{capture:true});};
  target.addEventListener('pointermove',onMove,true);target.addEventListener('pointerup',onUp,true);target.addEventListener('pointercancel',onCancel,true);
  return detach;
}
