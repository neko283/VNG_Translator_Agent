// Maintenance only: remove unused files from an already-copied upstream snapshot.
import ts from 'typescript';
import fs from 'node:fs';
import path from 'node:path';
const config=ts.readConfigFile('tsconfig.json',ts.sys.readFile);
const parsed=ts.parseJsonConfigFileContent(config.config,ts.sys,process.cwd());
const program=ts.createProgram(parsed.fileNames,parsed.options);
const keep=new Set(program.getSourceFiles().map(f=>path.resolve(f.fileName)));
const hashes=JSON.parse(fs.readFileSync('docs/upstream-hashes.json','utf8'));
const retained={};
function visit(dir){for(const e of fs.readdirSync(dir,{withFileTypes:true})){
  const f=path.join(dir,e.name);
  if(e.isDirectory()){visit(f);if(!fs.readdirSync(f).length)fs.rmdirSync(f);}
  else if(keep.has(path.resolve(f))){retained[f]=hashes[f];}
  else fs.unlinkSync(f);
}}
visit('upstream');
fs.writeFileSync('docs/upstream-hashes.json',JSON.stringify(retained,null,2)+'\n');
console.log(`Retained ${Object.keys(retained).length} upstream files; no external source links.`);
