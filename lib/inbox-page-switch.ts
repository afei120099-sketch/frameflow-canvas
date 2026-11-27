import {getSnapshot,type Editor} from 'tldraw';
import {waitForCanvasSave} from './canvas-library.ts';
import {readInboxRecovery} from './inbox-queue-protocol.ts';
export async function switchInboxPage(editor:Editor,pageId:string){
 if(editor.getCurrentPageId()===pageId)return true;
 const owner=readInboxRecovery(editor.getCurrentPageId());if(owner?.yield&&!await owner.yield())return false;
 await waitForCanvasSave('frameflow-v0.1-canvas',new Map(Object.entries(getSnapshot(editor.store).document.store)));
 if(!editor.getPages().some(page=>page.id===pageId))throw Error('目标页不存在，不创建替代页');
 editor.setCurrentPage(pageId as ReturnType<Editor['getCurrentPageId']>);return false;
}
