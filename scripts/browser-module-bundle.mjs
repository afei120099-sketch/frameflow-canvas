import {readFileSync} from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

/** Small test-only CommonJS bundle, compiled from this checkout without installing tools. */
export function browserModuleBundle(names){
 const definitions={},dependencies={},roots={};
 const add=name=>{
  let key=path.resolve(name).replaceAll('\\','/');if(!path.extname(key))key+='.ts';
  if(Object.hasOwn(definitions,key))return key;definitions[key]='';dependencies[key]={};
  const code=key.endsWith('.json')?'module.exports='+readFileSync(key,'utf8')+';':ts.transpileModule(readFileSync(key,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,esModuleInterop:true}}).outputText;
  for(const [,spec] of code.matchAll(/require\(["']([^"']+)["']\)/g)){
   if(!spec.startsWith('.'))throw Error('Unexpected external dependency: '+spec);
   dependencies[key][spec]=add(path.resolve(path.dirname(key),spec));
  }
  definitions[key]=code;return key;
 };
 for(const name of names)roots[name]=add('lib/'+name+'.ts');
 return `const defs=${JSON.stringify(definitions)},deps=${JSON.stringify(dependencies)},cache={};function load(id){if(cache[id])return cache[id].exports;const mod=cache[id]={exports:{}};new Function('module','exports','require',defs[id])(mod,mod.exports,name=>load(deps[id][name]));return mod.exports;}window.testModules=Object.fromEntries(Object.entries(${JSON.stringify(roots)}).map(([key,id])=>[key,load(id)]));`;
}
