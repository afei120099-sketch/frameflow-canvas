import assert from 'node:assert/strict';import fs from 'node:fs/promises';
const root='runtime/cover-v2-acceptance-20261017',results=[];
const cpu=async plan=>{const r=await fetch('http://localhost:5173/__cover/jobs',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(plan)});return {ok:r.ok,status:r.status,...await r.json()};};
const plan=JSON.parse(await fs.readFile(root+'/depth/plan.json','utf8'));
for(const [name,patch,pattern] of [['unsupported-glyph',{title:'逆光😀'},/字体不支持/],['outside-face',{actors:plan.actors.map(a=>({...a,x:-3}))},/面部超出/],['bad-data',{operation:'cutout',image:'bad-data'},/本地上传/]]){const r=await cpu({...plan,...patch});assert.equal(r.ok,false);assert.match(r.error,pattern);results.push({name,...r});}
const image='data:image/png;base64,'+(await fs.readFile('runtime/cover-acceptance-20261017/man.png')).toString('base64');const alpha='data:image/png;base64,'+(await fs.readFile(root+'/man/alpha.png')).toString('base64');
const manual=await cpu({operation:'cutout',image,alpha});assert.equal(manual.ok,true,JSON.stringify(manual));assert.equal(manual.method,'manual-alpha');
for(const name of ['alpha.png','raw-cutout.png','cutout.png','check-black.png','check-white.png','check-gray.png']){const r=await fetch(`http://localhost:5173/__cover/jobs/${manual.jobId}/${name}`);assert.equal(r.status,200,name);assert.ok((await r.arrayBuffer()).byteLength>100);}
results.push({name:'manual-alpha-and-three-background-routes',...manual});
await fs.writeFile(root+'/api-tests.json',JSON.stringify(results,null,2));console.log('Live CPU API: invalid inputs blocked; manual alpha saved; six protected output routes passed');
