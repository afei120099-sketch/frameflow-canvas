export interface BatchOutputBox {x:number;y:number;w:number;h:number}
/** Keep each new batch result centered below its own original. Existing nodes are never moved. */
export function batchOutputPosition(source:BatchOutputBox,size:{w:number;h:number},prior:BatchOutputBox[]=[],gap=100){
  const x=source.x+(source.w-size.w)/2;
  let y=source.y+source.h+gap;
  // Reprocessing the same source adds another row rather than covering an earlier result.
  for(const box of [...prior].sort((a,b)=>a.y-b.y)){
    if(x<box.x+box.w && x+size.w>box.x && y<box.y+box.h+gap && y+size.h+gap>box.y)y=box.y+box.h+gap;
  }
  return {x,y};
}
