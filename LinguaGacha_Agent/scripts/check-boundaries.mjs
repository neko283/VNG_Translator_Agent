import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import assert from 'node:assert/strict';
const root=fs.realpathSync('.');
function inside(file){const rel=path.relative(root,fs.realpathSync(file));assert.ok(rel!== '..'&&!rel.startsWith('..'+path.sep)&&!path.isAbsolute(rel),`Outside package: ${file}`);}
const parsed=ts.parseJsonConfigFileContent(ts.readConfigFile('tsconfig.json',ts.sys.readFile).config,ts.sys,root);
const program=ts.createProgram(parsed.fileNames,parsed.options);
for(const source of program.getSourceFiles())inside(source.fileName);
const meta=JSON.parse(fs.readFileSync('dist/build-inputs.json','utf8'));
for(const input of Object.keys(meta.inputs))inside(input);
const packageInfo=JSON.parse(fs.readFileSync('package.json','utf8'));
assert.ok(!packageInfo.devDependencies.node,'Node must use the installed host runtime');
for(const name of Object.keys(packageInfo.dependencies))assert.ok(!['electron','react','mupdf','jszip','exceljs'].includes(name));
for(const output of Object.values(meta.outputs))for(const entry of output.imports) {
  if(!entry.external||entry.path.startsWith('node:'))continue;
  const name=entry.path.startsWith('@')?entry.path.split('/').slice(0,2).join('/'):entry.path.split('/')[0];
  assert.ok(Object.hasOwn(packageInfo.dependencies,name),`Undeclared runtime dependency: ${name}`);
}
for(const directory of ['docs','skills','.agents','.claude'])walk(directory);
function walk(directory){for(const entry of fs.readdirSync(directory,{withFileTypes:true})) {
  const file=path.join(directory,entry.name);inside(file);
  if(entry.isDirectory())walk(file);
  else if(file.endsWith('.md')){
    const text=fs.readFileSync(file,'utf8');assert.equal((text.match(/^```/gm)||[]).length%2,0,`Unbalanced fences: ${file}`);
    for(const [,target] of text.matchAll(/\]\(([^)]+)\)/g))if(!/^(https?:|#)/.test(target)) {
      const linked=path.resolve(path.dirname(file),target.split('#')[0]);assert.ok(fs.existsSync(linked),`Broken link: ${file} → ${target}`);inside(linked);
    }
  }
}}
console.log(`Boundary check passed: ${Object.keys(meta.inputs).length} bundled inputs, all code/resources/links inside package.`);
