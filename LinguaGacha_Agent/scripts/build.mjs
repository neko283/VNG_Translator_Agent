import { build } from 'esbuild';
import { mkdir, writeFile } from 'node:fs/promises';
await mkdir('dist', {recursive:true});
const result = await build({entryPoints:['src/cli.ts'],outfile:'dist/cli.mjs',bundle:true,platform:'node',format:'esm',target:'node24',packages:'external',metafile:true});
await writeFile('dist/build-inputs.json',JSON.stringify(result.metafile,null,2));
