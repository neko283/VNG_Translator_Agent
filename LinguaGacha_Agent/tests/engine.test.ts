import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { AgentEngine } from '../src/engine';
import { PREFIX } from '../src/common';
import { run_project_database_migrations } from '../upstream/src/backend/migration/database-migrations';
import { ProjectDatabaseAccess } from '../upstream/src/backend/database/project-database-access';
import { ZstdTool } from '../upstream/src/backend/database/zstd-tool';
const scratch = path.resolve('.test-work');
await fs.mkdir(scratch, { recursive: true });
const root = await fs.mkdtemp(path.join(scratch, 'run-'));
after(() => fs.rm(root, { recursive: true, force: true }));
async function fixture(files: Record<string, string>, workflow: 'full' | 'translate' = 'translate') {
    const dir = await fs.mkdtemp(path.join(root, 'case-'));
    const input = path.join(dir, 'input');
    await fs.mkdir(input);
    for (const [name, value] of Object.entries(files)) {
        await fs.mkdir(path.dirname(path.join(input, name)), { recursive: true });
        await fs.writeFile(path.join(input, name), value);
    }
    const engine = new AgentEngine(path.join(dir, 'book.lg'));
    await engine.import(input);
    const task = await engine.start({ workflow });
    return { dir, input, engine, task };
}
function manual(batch: Awaited<ReturnType<AgentEngine['next']>>, dst = '译文') { return { items: batch.items.map(i => ({ item_id: i.item_id, fp: i.fp, dst, status: 'PROCESSED' })) }; }
test('three formats: exact upstream mapping, status fallback, fields and duplicate generation', async () => {
    const f = await fixture({ 'a.txt': 'Hello\r\n\r\nHello\n', 'kv.json': JSON.stringify({ 'Hi': '', 'Done': '完成', metadata: { v: 1 }, '': 'empty' }), 'message.json': JSON.stringify([{ name: 'Alice', message: 'Hello', extra: 17 }, { invalid: true }, { names: ['Bob', 8, 'Carol'], message: 'Goodbye' }]) });
    try {
        const b = await f.engine.next(f.task.id);
        assert.equal(b.phase, 'translation');
        const updates = b.items.map(i => ({ item_id: i.item_id, fp: i.fp, dst: i.src === 'Goodbye' ? '再见' : '你好', ...(i.name_src ? { name_dst: '爱丽丝' } : {}), status: 'PROCESSED' }));
        await f.engine.apply(f.task.id, b.attempt, { items: updates });
        const output = path.join(f.dir, 'output');
        const result = await f.engine.export(f.task.id, output);
        assert.equal(result.status, 'completed');
        assert.equal(await fs.readFile(path.join(output, 'a.txt'), 'utf8'), '你好\n\n你好');
        assert.deepEqual(JSON.parse(await fs.readFile(path.join(output, 'kv.json'), 'utf8')), { 'Hi': '你好', 'Done': '完成', metadata: { v: 1 }, '': 'empty' });
        assert.deepEqual(JSON.parse(await fs.readFile(path.join(output, 'message.json'), 'utf8')), [{ name: '爱丽丝', message: '你好' }, { names: ['爱丽丝', 'Carol'], message: '再见' }]);
        const query = await f.engine.query(f.task.id);
        assert.ok(query.items.some(i => i.status === 'DUPLICATED'));
        assert.equal((await f.engine.resume(f.task.id)).next, 'completed');
        await fs.writeFile(path.join(output, 'a.txt'), 'corrupt');
        assert.equal((await f.engine.resume(f.task.id)).next, 'export');
    }
    finally {
        await f.engine.close();
    }
});
test('partial acceptance, unchanged original values, empty and same-source completed translations', async () => {
    const f = await fixture({ 'a.txt': 'One\nTwo\nThree' });
    try {
        const b = await f.engine.next(f.task.id);
        const [a, c, d] = b.items;
        const result = await f.engine.apply(f.task.id, b.attempt, { items: [{ item_id: a!.item_id, fp: a!.fp, dst: '', status: 'PROCESSED' }, { item_id: c!.item_id, fp: c!.fp, dst: 'Two', status: 'PROCESSED' }, { item_id: d!.item_id, fp: d!.fp, status: 'ERROR' }] });
        assert.equal(result.status, 'partial');
        assert.equal(result.rejected.length, 1);
        const next = await f.engine.next(f.task.id);
        assert.deepEqual(next.items.map(i => i.src), ['Three']);
        const out = path.join(f.dir, 'output');
        await f.engine.export(f.task.id, out);
        assert.equal(await fs.readFile(path.join(out, 'a.txt'), 'utf8'), '\nTwo\nThree');
    }
    finally {
        await f.engine.close();
    }
});
test('lost response: replay receipt without writing; different payload forbidden; moved project resumes', async () => {
    const f = await fixture({ 'a.txt': 'Hello\nGoodbye' });
    const b = await f.engine.next(f.task.id, 1);
    const payload = manual(b);
    f.engine.afterCommitTestHook = () => { throw new Error('reply lost'); };
    await assert.rejects(f.engine.apply(f.task.id, b.attempt, payload), /reply lost/);
    await f.engine.close();
    const moved = path.join(f.dir, 'moved.lg');
    await fs.rename(path.join(f.dir, 'book.lg'), moved);
    const reopened = new AgentEngine(moved);
    try {
        const replay = await reopened.apply(f.task.id, b.attempt, payload);
        assert.equal('replayed' in replay && replay.replayed, true);
        await assert.rejects(reopened.apply(f.task.id, b.attempt, manual(b, 'different')), /different content/);
        assert.deepEqual((await reopened.next(f.task.id)).items.map(i => i.src), ['Goodbye']);
    }
    finally {
        await reopened.close();
    }
});
test('failure before COMMIT rolls back Item and receipt together', async () => {
    const f = await fixture({ 'a.txt': 'Hello' });
    try {
        const b = await f.engine.next(f.task.id);
        f.engine.beforeCommitTestHook = () => { throw new Error('power failure'); };
        await assert.rejects(f.engine.apply(f.task.id, b.attempt, manual(b)), /power failure/);
        assert.equal(await f.engine.receipt(b.attempt), null);
        assert.equal((await f.engine.query(f.task.id)).items[0]!.status, 'NONE');
        f.engine.beforeCommitTestHook = undefined;
        await f.engine.apply(f.task.id, b.attempt, manual(b));
        assert.equal((await f.engine.query(f.task.id)).items[0]!.status, 'PROCESSED');
    }
    finally {
        await f.engine.close();
    }
});
test('terminology persists, stale batches reject, full workflow review resumes and invalidates', async () => {
    const f = await fixture({ 'a.txt': 'Hello Alice' }, 'full');
    try {
        const terms = await f.engine.next(f.task.id);
        assert.equal(terms.phase, 'terms');
        await f.engine.apply(f.task.id, terms.attempt, { quality: { glossary: { creates: [{ src: 'Alice', dst: '爱丽丝', info: '角色', case_sensitive: false, sort: 0 }] } }, terms: { done: true, sources: ['user-provided text'] } });
        const stale = await f.engine.next(f.task.id);
        assert.equal(stale.quality.glossary.entries.length, 1);
        await f.engine.configure('glossary', { enabled: false });
        await assert.rejects(f.engine.apply(f.task.id, stale.attempt, manual(stale)), /Rules or configuration/);
        await f.engine.configure('glossary', { enabled: true });
        const b = await f.engine.next(f.task.id);
        await f.engine.apply(f.task.id, b.attempt, { translations: b.items.map(i => ({ item_id: i.item_id, fp: i.fp, text_dst: '你好，爱丽丝' })) });
        const review = await f.engine.next(f.task.id);
        assert.equal(review.phase, 'review');
        await f.engine.apply(f.task.id, review.attempt, { reviews: review.items.map(i => ({ item_id: i.item_id, fp: i.fp, verdict: 'pass', note: '已核对语义、术语和语气。' })) });
        assert.equal((await f.engine.resume(f.task.id)).next, 'export');
        await f.engine.configure('glossary', { enabled: false });
        assert.equal((await f.engine.resume(f.task.id)).next, 'review');
    }
    finally {
        await f.engine.close();
    }
});
test('external writer stale Item is rejected, unknown fields and unrelated tables survive', async () => {
    const f = await fixture({ 'a.txt': 'Hello\nGoodbye' });
    try {
        const b = await f.engine.next(f.task.id);
        const db = new DatabaseSync(f.engine.project);
        db.exec('CREATE TABLE external_data (v TEXT); INSERT INTO external_data VALUES (\'keep\')');
        const id = b.items[0]!.item_id as number;
        db.prepare("UPDATE items SET data=json_set(data,'$.dst',?,'$.future_field',?) WHERE id=?").run('外部更新', 'opaque', id);
        db.close();
        const result = await f.engine.apply(f.task.id, b.attempt, manual(b));
        assert.equal(result.status, 'partial');
        assert.ok(result.rejected.some(r => (r as {
            reason: string;
        }).reason === 'fp_mismatch'));
        const fresh = await f.engine.next(f.task.id);
        await f.engine.apply(f.task.id, fresh.attempt, manual(fresh));
        const read = new DatabaseSync(f.engine.project);
        assert.equal(read.prepare("SELECT json_extract(data,'$.future_field') AS v FROM items WHERE id=?").get(id)?.v, 'opaque');
        assert.equal(read.prepare('SELECT v FROM external_data').get()?.v, 'keep');
        read.close();
    }
    finally {
        await f.engine.close();
    }
});
test('mixed project: unsupported scope refused, supported subset preserves assets', async () => {
    const f = await fixture({ 'a.txt': 'Hello' });
    try {
        await f.engine.database.transaction(f.engine.project, w => w.add_asset(f.engine.project, 'old.epub', Buffer.from('opaque'), 'EPUB', null));
        await assert.rejects(f.engine.start(), /Unsupported/);
        const t = await f.engine.start({ files: ['a.txt'], workflow: 'translate' });
        assert.equal(t.files.length, 1);
        const contents = await f.engine.database.read(f.engine.project, w => w.read_asset_content(f.engine.project, 'old.epub'));
        assert.equal(contents?.toString(), 'opaque');
    }
    finally {
        await f.engine.close();
    }
});
test('source asset changes pause task, outside input changes do not replace stored source', async () => {
    const f = await fixture({ 'a.txt': 'Hello' });
    try {
        await fs.writeFile(path.join(f.input, 'a.txt'), 'New source');
        assert.equal((await f.engine.next(f.task.id)).items[0]!.src, 'Hello');
        await f.engine.database.transaction(f.engine.project, w => w.update_asset(f.engine.project, 'a.txt', Buffer.from('changed'), 'TXT', null));
        await assert.rejects(f.engine.resume(f.task.id), /Source assets changed/);
    }
    finally {
        await f.engine.close();
    }
});
test('original migration and access roundtrip preserve agent namespace; future migration refuses writes', async () => {
    const f = await fixture({ 'a.txt': 'Hello' });
    await f.engine.close();
    const db = new DatabaseSync(f.engine.project);
    run_project_database_migrations(db);
    const original = new ProjectDatabaseAccess(f.engine.project, db);
    original.upsert_meta_entries(f.engine.project, { name: 'original-core edit' });
    assert.ok(original.get_all_meta(f.engine.project)[PREFIX + 'task.' + f.task.id]);
    const raw = String(db.prepare('SELECT value FROM meta WHERE key=?').get('applied_writeback_migrations')!.value);
    const migrationIds = JSON.parse(raw);
    migrationIds.push('future-unknown');
    db.prepare('UPDATE meta SET value=? WHERE key=?').run(JSON.stringify(migrationIds), 'applied_writeback_migrations');
    db.close();
    const reopened = new AgentEngine(f.engine.project);
    await assert.rejects(reopened.inspect(), /Unknown project migration/);
    await reopened.close();
});
test('real subprocess death during transaction rolls back, completed subprocess can replay', async () => {
    const f = await fixture({ 'a.txt': 'Hello' });
    const b = await f.engine.next(f.task.id);
    await f.engine.close();
    const script = path.join(f.dir, 'crash.mts');
    const engineUrl = new URL('../src/engine.ts', import.meta.url).href;
    await fs.writeFile(script, `import {AgentEngine} from ${JSON.stringify(engineUrl)};const e=new AgentEngine(${JSON.stringify(f.engine.project)});e.beforeCommitTestHook=()=>process.exit(73);await e.apply(${JSON.stringify(f.task.id)},${JSON.stringify(b.attempt)},${JSON.stringify(manual(b))});`);
    const child = spawnSync(process.execPath, ['--import', 'tsx', script], { cwd: process.cwd(), encoding: 'utf8' });
    assert.equal(child.status, 73, child.stderr);
    const e = new AgentEngine(f.engine.project);
    try {
        assert.equal(await e.receipt(b.attempt), null);
        assert.equal((await e.next(f.task.id)).items[0]!.status, 'NONE');
        await e.apply(f.task.id, b.attempt, manual(b));
    }
    finally {
        await e.close();
    }
});
test('unsupported extension and malformed JSON do not create a project', async () => {
    const dir = await fs.mkdtemp(path.join(root, 'invalid-'));
    const input = path.join(dir, 'bad.json');
    await fs.writeFile(input, 'null');
    const e = new AgentEngine(path.join(dir, 'book.lg'));
    await assert.rejects(e.import(input), /Unsupported JSON/);
    await assert.rejects(fs.stat(e.project), { code: 'ENOENT' });
    await e.close();
});
test('zero-item assets follow upstream no-output behavior and are explicitly reported', async () => {
    const f = await fixture({ 'empty.txt': '', 'empty.json': '[]' });
    try {
        const result = await f.engine.export(f.task.id, path.join(f.dir, 'output'));
        assert.equal(result.files.length, 0);
        assert.deepEqual(result.zero_item_assets, ['empty.json', 'empty.txt']);
    }
    finally {
        await f.engine.close();
    }
});
test('pre/post replacement executes once and custom protection rejects damaged output', async () => {
    const f = await fixture({ 'a.txt': 'Hello TOKEN' });
    try {
        let b = await f.engine.next(f.task.id);
        await f.engine.apply(f.task.id, b.attempt, { quality: { pre_replacement: { creates: [{ src: 'Hello', dst: 'Greetings', regex: false, case_sensitive: true, sort: 0 }] }, post_replacement: { creates: [{ src: '您好', dst: '你好', regex: false, case_sensitive: true, sort: 0 }] }, text_preserve: { creates: [{ src: 'TOKEN', info: '必须保留', sort: 0 }] } } });
        await f.engine.configure('pre_replacement', { enabled: true });
        await f.engine.configure('post_replacement', { enabled: true });
        await f.engine.configure('text_preserve', { mode: 'custom' });
        b = await f.engine.next(f.task.id);
        assert.equal(b.items[0]!.request?.text_src, 'Greetings TOKEN');
        const bad = await f.engine.apply(f.task.id, b.attempt, { translations: [{ item_id: b.items[0]!.item_id, fp: b.items[0]!.fp, text_dst: '您好 WRONG' }] });
        assert.equal(bad.status, 'rejected');
        b = await f.engine.next(f.task.id);
        const good = await f.engine.apply(f.task.id, b.attempt, { translations: [{ item_id: b.items[0]!.item_id, fp: b.items[0]!.fp, text_dst: '您好 TOKEN' }] });
        assert.equal(good.status, 'applied');
        assert.equal((await f.engine.query(f.task.id)).items[0]!.dst, '你好 TOKEN');
    }
    finally {
        await f.engine.close();
    }
});
test('review and correction commit together; stale review cannot certify an external edit', async () => {
    const f = await fixture({ 'a.txt': 'Hello' }, 'full');
    try {
        const terms = await f.engine.next(f.task.id);
        await f.engine.apply(f.task.id, terms.attempt, { terms: { done: true } });
        const b = await f.engine.next(f.task.id);
        await f.engine.apply(f.task.id, b.attempt, manual(b));
        const review = await f.engine.next(f.task.id), i = review.items[0]!;
        await f.engine.apply(f.task.id, review.attempt, { items: [{ item_id: i.item_id, fp: i.fp, dst: '你好' }], reviews: [{ item_id: i.item_id, fp: i.fp, verdict: 'pass', note: '修订后确认' }] });
        assert.equal((await f.engine.resume(f.task.id)).remaining_review, 0);
        const db = new DatabaseSync(f.engine.project);
        db.prepare("UPDATE items SET data=json_set(data,'$.dst',?)").run('外部修改');
        db.close();
        assert.equal((await f.engine.resume(f.task.id)).remaining_review, 1);
    }
    finally {
        await f.engine.close();
    }
});
test('ERROR requires explicit retry and excluded/skipped items are never scheduled', async () => {
    const f = await fixture({ 'a.txt': 'Hello\n123\nGoodbye' });
    try {
        const db = new DatabaseSync(f.engine.project);
        db.prepare("UPDATE items SET data=json_set(data,'$.status','ERROR') WHERE id=1").run();
        db.prepare("UPDATE items SET data=json_set(data,'$.status','EXCLUDED') WHERE id=3").run();
        db.close();
        assert.equal((await f.engine.resume(f.task.id)).next, 'blocked');
        const retry = await f.engine.start({ workflow: 'translate', retry_errors: true });
        const b = await f.engine.next(retry.id);
        assert.deepEqual(b.items.map(i => i.item_id), [1]);
        await f.engine.apply(retry.id, b.attempt, manual(b));
        assert.equal((await f.engine.resume(retry.id)).next, 'export');
    }
    finally {
        await f.engine.close();
    }
});
test('UTF-16 BOM input keeps original bytes in zstd asset; output retains original writer normalization', async () => {
    const dir = await fs.mkdtemp(path.join(root, 'encoding-'));
    const file = path.join(dir, 'source.txt');
    const bytes = Buffer.concat([Buffer.from([255, 254]), Buffer.from('Hello\r\nGoodbye\r\n', 'utf16le')]);
    await fs.writeFile(file, bytes);
    const e = new AgentEngine(path.join(dir, 'project.lg'));
    try {
        await e.import(file);
        const t = await e.start({ workflow: 'translate' });
        const out = path.join(dir, 'output');
        await e.export(t.id, out);
        assert.equal(await fs.readFile(path.join(out, 'source.txt'), 'utf8'), 'Hello\nGoodbye');
        const db = new DatabaseSync(e.project);
        const blob = db.prepare('SELECT data FROM assets').get()!.data;
        assert.deepEqual(ZstdTool.decompress(Buffer.from(blob as Uint8Array)), bytes);
        db.close();
    }
    finally {
        await e.close();
    }
});
test('migration backup is consistent and preserves original namespace before migrations', async () => {
    const f = await fixture({ 'a.txt': 'Hello' });
    await f.engine.close();
    const db = new DatabaseSync(f.engine.project);
    db.prepare('UPDATE meta SET value=? WHERE key=?').run('[]', 'applied_writeback_migrations');
    db.close();
    const e = new AgentEngine(f.engine.project);
    try {
        await e.inspect();
        const backups = (await fs.readdir(f.dir)).filter(n => n.includes('.before-migration-'));
        assert.equal(backups.length, 1);
        const backup = new DatabaseSync(path.join(f.dir, backups[0]!));
        assert.ok(backup.prepare('SELECT value FROM meta WHERE key=?').get(PREFIX + 'task.' + f.task.id));
        assert.equal(backup.prepare('PRAGMA integrity_check').get()!.integrity_check, 'ok');
        backup.close();
    }
    finally {
        await e.close();
    }
});
test('two independent CLI processes replay the same attempt without duplicate writes', async () => {
    const f = await fixture({ 'a.txt': 'Hello' });
    const b = await f.engine.next(f.task.id);
    await f.engine.close();
    const changes = path.join(f.dir, 'changes.json');
    await fs.writeFile(changes, JSON.stringify(manual(b)));
    const { spawn } = await import('node:child_process');
    function call() { return new Promise<Record<string, unknown>>((resolve, reject) => { const child = spawn(process.execPath, ['dist/cli.mjs', 'apply', f.engine.project, '--task', f.task.id, '--attempt', b.attempt, '--changes', changes], { cwd: process.cwd() }); let out = '', err = ''; child.stdout.on('data', d => out += d); child.stderr.on('data', d => err += d); child.on('error', reject); child.on('close', code => code === 0 ? resolve(JSON.parse(out)) : reject(new Error(err))); }); }
    const results = await Promise.all([call(), call()]);
    assert.equal(results.filter(r => r.replayed === true).length, 1);
    const e = new AgentEngine(f.engine.project);
    try {
        const facts = await e.query(f.task.id);
        assert.equal(facts.items[0]!.status, 'PROCESSED');
    }
    finally {
        await e.close();
    }
});
test('portable bundle works from a copied package with no upstream source directory', async () => {
    const dir = await fs.mkdtemp(path.join(root, 'portable-'));
    await fs.cp('bin', path.join(dir, 'bin'), { recursive: true });
    await fs.cp('dist', path.join(dir, 'dist'), { recursive: true });
    // Copy only runtime packages; resolving against the original source tree is impossible here.
    for (const pkg of ['chardet', 'iconv-lite', 'safer-buffer', 'jsonrepair', 'typebox'])
        await fs.cp(path.join('node_modules', pkg), path.join(dir, 'node_modules', pkg), { recursive: true });
    await fs.writeFile(path.join(dir, 'input.txt'), 'Hello');
    const call = (args: string[]) => { const r = spawnSync(process.execPath, ['bin/lg-agent.mjs', ...args], { cwd: dir, encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); return JSON.parse(r.stdout); };
    assert.equal(call(['doctor']).node, process.version);
    call(['import', 'input.txt', '--project', 'project.lg']);
    const task = call(['start', 'project.lg', '--workflow', 'translate']);
    const b = call(['next', 'project.lg', '--task', task.id]);
    await fs.writeFile(path.join(dir, 'changes.json'), JSON.stringify(manual(b)));
    call(['apply', 'project.lg', '--task', task.id, '--attempt', b.attempt, '--changes', 'changes.json']);
    call(['export', 'project.lg', '--task', task.id, '--output', 'output']);
    assert.equal(await fs.readFile(path.join(dir, 'output/input.txt'), 'utf8'), '译文');
});
test('output path traversal and bilingual collisions refuse before any output write', async () => {
    const f = await fixture({ 'a.txt': 'Hello', 'bilingual/a.txt': 'Goodbye' });
    try {
        await assert.rejects(f.engine.export(f.task.id, path.join(f.dir, 'output')));
        await assert.rejects(fs.stat(path.join(f.dir, 'output')), { code: 'ENOENT' });
    }
    finally {
        await f.engine.close();
    }
});
test('original changes directory accepts item-only updates; per-item receipt is explicit', async () => {
    const f = await fixture({ 'a.txt': 'Hello' });
    const b = await f.engine.next(f.task.id);
    await f.engine.close();
    const changes = path.join(f.dir, 'changes');
    await fs.mkdir(path.join(changes, 'items'), { recursive: true });
    await fs.writeFile(path.join(changes, 'items/updates.jsonl'), JSON.stringify(manual(b).items[0]) + '\n');
    const child = spawnSync(process.execPath, ['bin/lg-agent.mjs', 'apply', f.engine.project, '--task', f.task.id, '--attempt', b.attempt, '--changes', changes], { cwd: process.cwd(), encoding: 'utf8' });
    assert.equal(child.status, 0, child.stderr);
    const receipt = JSON.parse(child.stdout);
    assert.deepEqual(receipt.item_results, [{ item_id: b.items[0]!.item_id, accepted: true, changed: true, rejected_records: false }]);
    assert.equal(receipt.checkpoint_saved, true);
});
test('unfinished term investigation survives a fresh engine and is returned with current glossary', async () => {
    const f = await fixture({ 'a.txt': 'Hello Alice' }, 'full');
    const b = await f.engine.next(f.task.id);
    const terms = { done: false, sources: ['official reference supplied by user'], candidates: [{ src: 'Alice', dst: '爱丽丝', reason: 'awaiting confirmation' }] };
    await f.engine.apply(f.task.id, b.attempt, { terms });
    await f.engine.close();
    const e = new AgentEngine(f.engine.project);
    try {
        const progress = await e.resume(f.task.id);
        assert.deepEqual(progress.terms, terms);
        assert.equal(progress.next, 'terms');
        const next = await e.next(f.task.id);
        assert.deepEqual(next.terms, terms);
        assert.equal(next.languages.target_language, 'ZH');
    }
    finally {
        await e.close();
    }
});
test('prepared source facts remain fixed even if another Item changes before partial apply', async () => {
    const f = await fixture({ 'a.txt': 'Hello [Alice](https://example.com/a)\nGoodbye [Bob](https://example.com/b)' });
    try {
        const b = await f.engine.next(f.task.id);
        assert.equal(b.items.length, 2);
        const db = new DatabaseSync(f.engine.project);
        db.prepare("UPDATE items SET data=json_set(data,'$.src',?) WHERE id=?").run('Hello changed with no resource', b.items[0]!.item_id);
        db.close();
        const translations = b.items.map(i => ({ item_id: i.item_id, fp: i.fp, text_dst: i.request!.text_src.replace('Hello', '你好').replace('Goodbye', '再见').replace('Alice', '爱丽丝').replace('Bob', '鲍勃') }));
        const result = await f.engine.apply(f.task.id, b.attempt, { translations });
        assert.equal(result.status, 'partial');
        const rows = (await f.engine.query(f.task.id)).items;
        assert.ok(rows[1]!.dst.includes('https://example.com/b'));
        assert.ok(!rows[1]!.dst.includes('https://example.com/a'));
    }
    finally {
        await f.engine.close();
    }
});
