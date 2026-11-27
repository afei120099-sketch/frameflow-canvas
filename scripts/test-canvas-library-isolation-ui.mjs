import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
const {chromium}=await import(pathToFileURL(process.argv[2]).href);
const browser=await chromium.launch({headless:true,executablePath:process.argv[3]});
const context=await browser.newContext({viewport:{width:1400,height:950}});
const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
try{
 await page.goto('http://127.0.0.1:5174/isolation-smoke');
 const choose=page.getByLabel('切换画布',{exact:true});await choose.waitFor({timeout:90000});
 await page.getByRole('button',{name:'测试角色库',exact:true}).click();
 await page.getByRole('button',{name:/A专属角色/}).waitFor();assert.equal(await page.getByRole('button',{name:/B专属角色/}).count(),0);
 await page.getByRole('button',{name:'关闭',exact:true}).click();
 await page.getByRole('button',{name:'测试素材库',exact:true}).click();await page.getByRole('button',{name:/A专属图片/}).waitFor();assert.equal(await page.getByRole('button',{name:/B专属图片/}).count(),0);
 await page.getByRole('button',{name:'关闭素材库',exact:true}).click();
 await choose.selectOption({label:'验收画布B'});
 await page.getByRole('button',{name:'测试角色库',exact:true}).click();await page.getByRole('button',{name:/B专属角色/}).waitFor();assert.equal(await page.getByRole('button',{name:/A专属角色/}).count(),0);
 await page.getByRole('button',{name:'关闭',exact:true}).click();await page.getByRole('button',{name:'测试素材库',exact:true}).click();await page.getByRole('button',{name:/B专属图片/}).waitFor();assert.equal(await page.getByRole('button',{name:/A专属图片/}).count(),0);
 await page.getByRole('button',{name:'关闭素材库',exact:true}).click();
 await page.getByRole('button',{name:'新建画布',exact:true}).click();await page.getByLabel('新画布名称',{exact:true}).fill('验收空白画布C');await page.getByRole('button',{name:'创建',exact:true}).click();
 await page.waitForFunction(()=>[...document.querySelectorAll('select[aria-label="切换画布"] option')].some(o=>o.selected&&o.textContent==='验收空白画布C'));
 await page.getByRole('button',{name:'测试角色库',exact:true}).click();await page.getByText('还没有角色。',{exact:false}).waitFor();await page.getByRole('button',{name:'关闭',exact:true}).click();
 await page.getByRole('button',{name:'测试素材库',exact:true}).click();await page.getByText('素材库为空，可从上方导入',{exact:true}).waitFor();await page.getByRole('button',{name:'关闭素材库',exact:true}).click();
 await page.reload();await page.getByLabel('切换画布',{exact:true}).waitFor({timeout:60000});await page.getByLabel('切换画布',{exact:true}).selectOption({label:'验收画布A'});
 await page.getByRole('button',{name:'测试角色库',exact:true}).click();await page.getByRole('button',{name:/A专属角色/}).waitFor();assert.equal(await page.getByRole('button',{name:/B专属角色/}).count(),0);
 assert.deepEqual(errors.filter(e=>!e.includes('ResizeObserver')),[]);
 console.log('PASS real browser UI: A/B roles and assets isolated, normal page switch/save, empty new C, reload retained A. Isolated browser storage only; no user canvas or GPU touched.');
}finally{await context.close();await browser.close();}
