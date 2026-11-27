import assert from 'node:assert/strict';
import ts from 'typescript';
/** G intentionally changes submission policy. Preserve the actual lifetime/page guard, not a frozen whole hook.
 * 2026-11-12 停止排队修复 intentionally rewrote stop/stopWaiting (bounded steps, visible report, force unlock);
 * their behaviour is covered by scripts/test-queue-stop.mjs instead of a frozen body. */
export function assertQueueLifecyclePreserved(current, baseline) {
  const extract=source=>{
    const ast=ts.createSourceFile('hook.ts',source,ts.ScriptTarget.Latest,true),result={};
    const visit=node=>{
      if(ts.isVariableDeclaration(node)&&['guard'].includes(node.name.getText(ast)))result[node.name.getText(ast)]=node.getText(ast).replaceAll('\r\n','\n');
      if(ts.isCallExpression(node)&&node.expression.getText(ast)==='useEffect'&&node.arguments[0]?.getText(ast).includes('mounted.current = true'))result.lifetime=node.getText(ast).replaceAll('\r\n','\n');
      ts.forEachChild(node,visit);
    };visit(ast);return result;
  };
  const old=extract(baseline);assert.equal(Object.keys(old).length,2);assert.deepEqual(extract(current),old,'queue mount/page guard remain identical');
  assert.match(current,/const stopWaiting = async/);assert.match(current,/const stop = async/);assert.doesNotMatch(current,/interrupt/i,'stop never interrupts the running ComfyUI job');
}
