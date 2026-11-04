import { parseArgs } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ZstdTool } from '../upstream/src/backend/database/zstd-tool';
import { AgentEngine, type Workflow } from './engine';
import { record } from './common';
import type { QualityRuleKind } from '../upstream/src/domain/quality';
import { FORMATS } from './formats';
const help = `lg-agent — standalone .lg translation workflow (Node >=24.22.1)
  doctor
  import INPUT --project PROJECT.lg [--source-language ALL] [--target-language ZH]
  inspect PROJECT.lg
  start PROJECT.lg [--files a.txt,b.json] [--workflow full|translate] [--retry-errors] [--retranslate]
  resume PROJECT.lg [--task ID]
  next PROJECT.lg [--task ID] [--limit 20]
  query PROJECT.lg [--task ID]
  apply PROJECT.lg --task ID --attempt ID --changes changes.json|updates.jsonl|directory
  configure PROJECT.lg --kind glossary --enabled true
  configure PROJECT.lg --kind text_preserve --mode custom
  pause PROJECT.lg --task ID --reason TEXT
  receipt PROJECT.lg --attempt ID
  export PROJECT.lg --task ID --output DIRECTORY

next emits a durable attempt ID, item fp, prepared translation requests, current rules and context.
apply accepts {translations:[{item_id,fp,text_dst,actor_dst?}]} for pipeline output,
{items:[{item_id,fp,dst?,name_dst?,status?}]} for final manual patches,
{quality:{glossary:{creates:[{src,dst,info,case_sensitive,sort}],updates:[],deletes:[]}}},
{terms:{done:true,sources:[],notes:"..."}}, or {reviews:[{item_id,fp,verdict:"pass",note:"..."}]}.
Use next again after any rule changes. No model API is called by this CLI.
`;
async function readChanges(file: string): Promise<unknown> {
    const stat = await fs.stat(file);
    if (!stat.isDirectory()) {
        const source = await fs.readFile(file, 'utf8');
        return file.endsWith('.jsonl') ? { items: source.split(/\r?\n/).filter(x => x.trim()).map(line => {
                try {
                    return JSON.parse(line);
                }
                catch {
                    return { invalid_json: line };
                }
            }) } : JSON.parse(source);
    }
    const allowed = new Set(['items/updates.jsonl', ...['glossary', 'text_preserve', 'pre_replacement', 'post_replacement'].flatMap(k => ['creates', 'updates', 'deletes'].map(op => `${k}/${op}.jsonl`))]);
    async function validateDirectory(relative = ''): Promise<void> {
        for (const entry of await fs.readdir(path.join(file, relative), { withFileTypes: true })) {
            const name = path.posix.join(relative, entry.name);
            if (entry.isDirectory())
                await validateDirectory(name);
            else if (!entry.isFile() || !allowed.has(name))
                throw new Error(`Unsupported changes file: ${name}`);
        }
    }
    await validateDirectory();
    const result: Record<string, unknown> = {};
    async function lines(relative: string) {
        try {
            return (await fs.readFile(path.join(file, relative), 'utf8')).split(/\r?\n/).filter(x => x.trim()).map(line => {
                try {
                    return JSON.parse(line);
                }
                catch {
                    return { invalid_json: line };
                }
            });
        }
        catch (e) {
            if ((e as NodeJS.ErrnoException).code === 'ENOENT')
                return [];
            throw e;
        }
    }
    result.items = await lines('items/updates.jsonl');
    const quality: Record<string, unknown> = {};
    for (const kind of ['glossary', 'text_preserve', 'pre_replacement', 'post_replacement']) {
        const ops = { creates: await lines(`${kind}/creates.jsonl`), updates: await lines(`${kind}/updates.jsonl`), deletes: await lines(`${kind}/deletes.jsonl`) };
        if (Object.values(ops).some(a => a.length))
            quality[kind] = ops;
    }
    result.quality = quality;
    return result;
}
async function main() {
    const args = parseArgs({ allowPositionals: true, options: { project: { type: 'string' }, task: { type: 'string' }, attempt: { type: 'string' }, changes: { type: 'string' }, output: { type: 'string' }, files: { type: 'string' }, workflow: { type: 'string' }, limit: { type: 'string' }, 'source-language': { type: 'string' }, 'target-language': { type: 'string' }, 'retry-errors': { type: 'boolean' }, retranslate: { type: 'boolean' }, 'clean-ruby': { type: 'boolean' }, kind: { type: 'string' }, enabled: { type: 'string' }, mode: { type: 'string' }, reason: { type: 'string' }, help: { type: 'boolean' } } });
    const [command, target] = args.positionals;
    const v = args.values;
    if (!command || command === 'help' || v.help) {
        console.log(help);
        return;
    }
    const [major, minor, patch] = process.versions.node.split('.').map(Number);
    if (major! < 24 || (major === 24 && (minor! < 22 || (minor === 22 && patch! < 1))))
        throw new Error('Node.js >=24.22.1 is required');
    if (command === 'doctor') {
        const db = new DatabaseSync(':memory:');
        db.exec('CREATE TABLE probe (value TEXT)');
        db.prepare('INSERT INTO probe VALUES (?)').run('ok');
        const sqlite = db.prepare('SELECT value FROM probe').get()?.value === 'ok';
        db.close();
        const input = Buffer.from('LinguaGacha');
        const zstd = ZstdTool.isRuntimeAvailable() && ZstdTool.decompress(ZstdTool.compress(input)).equals(input);
        if (!sqlite || !zstd)
            throw new Error('SQLite or zstd runtime probe failed');
        return { node: process.version, executable: process.execPath, sqlite, zstd, formats: FORMATS, electron: false };
    }
    const project = command === 'import' ? v.project : target;
    if (!project)
        throw new Error('Project path required');
    const engine = new AgentEngine(project);
    try {
        switch (command) {
            case 'import':
                if (!target)
                    throw new Error('Input required');
                return await engine.import(target, v['source-language'] ?? 'ALL', v['target-language'] ?? 'ZH');
            case 'inspect': return await engine.inspect();
            case 'start': return await engine.start({ files: v.files?.split(','), workflow: v.workflow as Workflow | undefined, source_language: v['source-language'], target_language: v['target-language'], retry_errors: v['retry-errors'], retranslate: v.retranslate, clean_ruby: v['clean-ruby'] });
            case 'resume': return await engine.resume(v.task);
            case 'next': return await engine.next(v.task, v.limit ? Number(v.limit) : 20);
            case 'query': return await engine.query(v.task);
            case 'apply':
                if (!v.attempt || !v.changes)
                    throw new Error('--attempt and --changes required');
                return await engine.apply(v.task, v.attempt, await readChanges(v.changes));
            case 'pause':
                if (!v.reason)
                    throw new Error('--reason required');
                return await engine.pause(v.task, v.reason);
            case 'configure':
                if (!v.kind)
                    throw new Error('--kind required');
                if (v.kind !== 'text_preserve' && !['true', 'false'].includes(v.enabled ?? ''))
                    throw new Error('--enabled must be true or false');
                return await engine.configure(v.kind as QualityRuleKind, v.kind === 'text_preserve' ? { mode: v.mode } : { enabled: v.enabled === 'true' });
            case 'receipt':
                if (!v.attempt)
                    throw new Error('--attempt required');
                return await engine.receipt(v.attempt);
            case 'export':
                if (!v.output)
                    throw new Error('--output required');
                return await engine.export(v.task, v.output);
            default: throw new Error(`Unknown command: ${command}`);
        }
    }
    finally {
        await engine.close();
    }
}
try {
    const result = await main();
    if (result !== undefined)
        console.log(JSON.stringify(result, null, 2));
}
catch (error) {
    const e = error instanceof Error ? error : new Error(String(error));
    console.error(JSON.stringify({ error: e.message, ...('code' in e ? { code: e.code } : {}), ...('public_details' in e ? { details: e.public_details } : {}), ...(process.env.LG_AGENT_DEBUG ? { stack: e.stack } : {}) }, null, 2));
    process.exitCode = 1;
}
