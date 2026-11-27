import assert from 'node:assert/strict';import ts from'typescript';
function pollingEffect(source,name,needle){const ast=ts.createSourceFile('workspace.tsx',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);const fn=ast.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text===name);const statement=fn.body.statements.find(n=>ts.isExpressionStatement(n)&&ts.isCallExpression(n.expression)&&n.expression.expression.getText(ast)==='useEffect'&&n.getText(ast).includes(needle));assert.ok(statement,name+' polling effect found');return{start:statement.getStart(ast),end:statement.end,text:statement.getText(ast)};}
/** Invert only H's two specified status/review effects, never generation or shared Run clocks. */
export function normalizeHDisplayPolling(source,baseline){
 for(const [name,currentNeedle,oldNeedle]of[['LocalSystemStatus','startVisibleStatusPoll','readJson'],['H3SubmissionInfo','roleWatchKey','roleWatchKey']]){const current=pollingEffect(source,name,currentNeedle),old=pollingEffect(baseline,name,oldNeedle);source=source.slice(0,current.start)+old.text+source.slice(current.end);}
 return source.replace('import { startVisibleStatusPoll } from "@/lib/visible-status-poll";\n','').replace('  const refreshStatus = useRef<(() => void) | null>(null);\n','').replace('    <button type="button" onClick={() => refreshStatus.current?.()}>立即检查连接</button>\n','');
}
