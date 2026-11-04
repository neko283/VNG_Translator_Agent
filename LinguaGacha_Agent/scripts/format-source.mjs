import ts from 'typescript';
import fs from 'node:fs';
const printer=ts.createPrinter({newLine:ts.NewLineKind.LineFeed});
for(const dir of ['src','tests'])for(const file of fs.readdirSync(dir).filter(f=>f.endsWith('.ts'))) {
  const name=`${dir}/${file}`;const source=ts.createSourceFile(name,fs.readFileSync(name,'utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.TS);
  fs.writeFileSync(name,printer.printFile(source));
}
