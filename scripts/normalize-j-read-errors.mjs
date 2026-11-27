import assert from'node:assert/strict';import ts from'typescript';
function fn(source,name){const ast=ts.createSourceFile('workspace.tsx',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX),node=ast.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text===name);assert.ok(node);return{start:node.getStart(ast),end:node.end,text:node.getText(ast)};}
export function normalizeJReadErrors(source,baseline){
 const now=fn(source,'useImageUrl'),old=fn(baseline,'useImageUrl');source=source.slice(0,now.start)+old.text+source.slice(now.end);
 return source.replace('import { useImageReadState } from "@/components/canvas/use-image-read-state";\n','')
 .replace('  const imageRead = useImageReadState(shape.props.src, shape.id);\n  const url = imageRead.url;','  const url = useImageUrl(shape.props.src);')
 .replace('{url ? <img src={url} alt={shape.props.name} draggable={false} onError={() => imageRead.fail("图片解码失败，请重新选择原图")} /> : imageRead.error ? <button type="button" role="alert" title={imageRead.error} onPointerDown={stopPropagation} onClick={(event) => { event.stopPropagation(); input.current?.click(); }}>图片无法读取 · 重新选择</button> : <span>正在恢复图片…</span>}','{url ? <img src={url} alt={shape.props.name} draggable={false} /> : <span>正在恢复图片…</span>}')
 .replace('<em title={timing.syncWarning ?? "等待时间包含提交准备与排队；生成时间从 ComfyUI 开始执行工作流计算"}>','<em title="等待时间包含提交准备与排队；生成时间从 ComfyUI 开始执行工作流计算">')
 .replace('{timing.syncWarning ? " · ⚠ 数据同步异常" : ""}</em>','</em>');
}
