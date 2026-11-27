// Fresh headless browser context; all ComfyUI calls are intercepted. No GPU jobs.
import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
const [entry,executablePath,baseUrl='http://127.0.0.1:5173/']=process.argv.slice(2);
const {chromium}=await import(pathToFileURL(entry).href);
const browser=await chromium.launch({executablePath,headless:true});
const context=await browser.newContext({viewport:{width:1600,height:1100}});
const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));page.on('requestfailed',r=>console.error('Request failed',new URL(r.url()).pathname,r.failure()?.errorText));page.on('console',m=>{if(m.type()==='error')console.error('Console',m.text().slice(0,700));});
// A one-second silent WAV fixture tests browser decoding only, not generated speech quality.
const wave=Buffer.alloc(44+48000*2);wave.write('RIFF',0);wave.writeUInt32LE(wave.length-8,4);wave.write('WAVEfmt ',8);wave.writeUInt32LE(16,16);wave.writeUInt16LE(1,20);wave.writeUInt16LE(1,22);wave.writeUInt32LE(48000,24);wave.writeUInt32LE(96000,28);wave.writeUInt16LE(2,32);wave.writeUInt16LE(16,34);wave.write('data',36);wave.writeUInt32LE(wave.length-44,40);
let promptId='',posts=0,sent;
await context.route('**/__automation/**',route=>route.fulfill({status:503,body:'isolated UI test'}));
await context.route(url=>url.pathname.startsWith('/comfyui/'),async route=>{
 const path=new URL(route.request().url()).pathname.replace('/comfyui','');
 const json=value=>route.fulfill({contentType:'application/json',body:JSON.stringify(value)});
 if(path.startsWith('/object_info/'))return json({[path.split('/').at(-1)]:{}});
 if(path==='/upload/image')return json({name:'reference.wav'});
 if(path==='/prompt'){posts++;sent=route.request().postDataJSON();promptId=sent.prompt_id;return json({prompt_id:promptId});}
 if(path.startsWith('/history/'))return json(promptId?{[promptId]:{status:{completed:true},outputs:{'4':{audio:[{filename:'Frameflow_CosyVoice_test.mp3',subfolder:'audio',type:'output'}]}}}}:{});
 if(path==='/queue')return json({queue_running:[],queue_pending:[]});
 if(path==='/view')return route.fulfill({contentType:'audio/mpeg',body:wave});
 return json({});
});
try{
 await page.goto(baseUrl);console.log('Loaded isolated test page');await page.getByRole('button',{name:'添加素材或节点',exact:true}).waitFor({timeout:60000});
 await page.locator('input[type="file"][accept="audio/*,.m4a"]').setInputFiles({name:'参考声音.wav',mimeType:'audio/wav',buffer:wave});
 await page.locator('.tl-shape[data-shape-type="audio-node"]').waitFor();
 await page.getByRole('button',{name:'添加素材或节点',exact:true}).click();
 await page.locator('.add-dock-menu').getByRole('button',{name:'文生配音',exact:true}).click();
 const node=page.locator('.tl-shape[data-shape-type="tts-node"]');await node.waitFor();
 await node.getByLabel('配音参考音色').selectOption({label:'参考声音.wav'});
 await node.getByLabel('配音台词',{exact:true}).fill('你好，这是配音节点测试。');
 await node.getByRole('button',{name:'生成配音',exact:true}).click();
 await node.getByText('配音完成',{exact:true}).waitFor();
 assert.equal(posts,1);assert.equal(sent.prompt['3'].inputs.text,'你好，这是配音节点测试。');
 await node.getByRole('button',{name:'加入角色信息',exact:true}).click();
 const dialog=page.getByRole('dialog',{name:'将配音加入角色'});
 await dialog.getByLabel('新角色名称').fill('画布配音测试角色');
 await dialog.getByRole('checkbox').check();
 await dialog.getByRole('button',{name:'加入并打开角色信息'}).click();
 const detail=page.getByRole('dialog',{name:'角色资产'});await detail.getByRole('heading',{name:'画布配音测试角色'}).waitFor();
 assert.equal(await detail.locator('label').filter({hasText:'角色名称'}).locator('input').inputValue(),'画布配音测试角色');
 assert.ok((await detail.textContent()).includes('主声音'));
 assert.ok((await detail.textContent()).includes('Frameflow_CosyVoice_test.mp3'));
 await detail.getByRole('button',{name:'关闭',exact:true}).click();
 await node.getByRole('button',{name:'放为声音节点',exact:true}).click();
 assert.equal(await page.locator('.tl-shape[data-shape-type="audio-node"]').count(),2);
 await page.waitForTimeout(1400);await page.reload();
 await page.locator('.tl-shape[data-shape-type="tts-node"]').waitFor({timeout:60000});
 await page.locator('.tl-shape[data-shape-type="tts-node"]').getByText('配音完成',{exact:true}).waitFor();
 assert.equal(posts,1,'reload cannot resubmit a generated task');
 assert.deepEqual(errors,[]);
 console.log('PASS isolated browser: create node, canvas timbre, mocked audio generation, add/set primary/open role details, place audio, reload persistence; no real GPU requests');
}catch(error){console.error('Browser errors:',errors);console.error('Page:',(await page.locator('body').innerText()).slice(0,2500));throw error;}finally{await browser.close();}
