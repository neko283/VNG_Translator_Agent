import { readFileSync } from 'node:fs';
import { AGENT_WORKSPACE_QUALITY_SCHEMAS, type AgentWorkspaceItem } from "../upstream/src/backend/agent/workspace/schema";
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Check } from 'typebox/value';
import { ProjectDatabase, type ProjectDatabaseAccess } from '../upstream/src/backend/database/database-operations';
import { ProjectWriteStore } from '../upstream/src/backend/project/project-write-store';
import { ProjectDataReader } from '../upstream/src/backend/project/project-data-reader';
import { create_item, build_project_item_public_record, PROJECT_ITEM_MANUAL_UPDATE_SCHEMA, type Item } from '../upstream/src/domain/item';
import { create_empty_agent_workspace_intent_batch, project_agent_workspace_item, project_agent_workspace_quality_entry, type AgentWorkspaceIntentBatch } from '../upstream/src/backend/project/agent-workspace-write';
import { compute_project_prefilter_write } from '../upstream/src/backend/project/project-write-state';
import { build_project_file_records } from '../upstream/src/backend/project/project-file-records';
import { read_project_prefilter_settings, read_project_language_settings } from '../upstream/src/domain/project-settings';
import { normalize_text_processing_config, read_text_quality_snapshot } from '../upstream/src/shared/text/text-processing';
import { TranslationPrePipeline } from '../upstream/src/backend/batch-translation/work-unit/pipeline/translation-pre-pipeline';
import { TranslationPostPipeline } from '../upstream/src/backend/batch-translation/work-unit/pipeline/translation-post-pipeline';
import { evaluateProofreadingItem, buildProofreadingEvaluationContext } from '../upstream/src/shared/proofreading/proofreading-evaluator';
import { QualityRule, QUALITY_RULE_KINDS, type QualityRuleKind } from '../upstream/src/domain/quality';
import type { JsonRecord } from '../upstream/src/domain/json';
import { FORMATS, readInput, generate, defaultConfig } from './formats';
import { PREFIX, hash, json, record, keys, text } from './common';
function workspaceItem(item: Item): AgentWorkspaceItem {
    return project_agent_workspace_item(item) as unknown as AgentWorkspaceItem;
}
export type Workflow = 'full' | 'translate';
interface Task {
    version: 1;
    id: string;
    created_at: string;
    files: string[];
    workflow: Workflow;
    source_language: string;
    target_language: string;
    retry_errors: boolean;
    retranslate: boolean;
    assets_hash: string;
    terms_done: boolean;
    stage: string;
    status: string;
    clean_ruby: boolean;
    deduplication_in_bilingual: boolean;
    write_translated_name_fields_to_file: boolean;
}
interface Batch {
    version: 1;
    id: string;
    task: string;
    phase: string;
    basis: string;
    ids: number[];
    fps: Record<string, string>;
    inputs: Item[]; // Rebuild identical resource-reference ordinals after concurrent Item changes.
    state: string;
    created_at: string;
}
interface Review {
    version: 1;
    fp: string;
    basis: string;
    verdict: 'pass' | 'needs_revision';
    note: string;
}
interface Receipt {
    version: 1;
    attempt: string;
    task: string;
    payload_hash: string;
    status: string;
    applied: unknown;
    rejected: unknown[];
    section_revisions: unknown;
    item_results: {
        item_id: number;
        accepted: boolean;
        changed: boolean;
        rejected_records: boolean;
    }[];
    reviewed_item_ids: number[];
    quality_entry_ids_after: Record<string, string[]>;
    checkpoint_saved: true;
}
export class AgentEngine {
    readonly database = new ProjectDatabase();
    readonly store = new ProjectWriteStore(this.database, () => { }, null);
    readonly project: string;
    constructor(project: string) { this.project = path.resolve(project); }
    async close() { await this.database.close(); }
    private snapshot(writer: ProjectDatabaseAccess) {
        const reader = new ProjectDataReader(writer);
        const project = this.project;
        const meta = writer.get_all_meta(project);
        const items = writer.get_all_items(project).map(create_item);
        const assets = writer.get_all_asset_records(project).map(a => ({ ...a, content: writer.read_asset_content(project, a.path)! }));
        if (assets.some(a => a.content === null))
            throw new Error('Missing source asset');
        const quality = reader.build_quality_block(project, meta);
        const prompts = reader.build_prompts_block(project, meta);
        return { meta, items, assets, quality, prompts, revisions: reader.build_section_revisions(meta) };
    }
    private task(meta: JsonRecord, id?: string): Task {
        const tasks = Object.entries(meta).filter(([k]) => k.startsWith(PREFIX + 'task.')).map(([, v]) => v as unknown as Task);
        const matches = id ? tasks.filter(t => t.id === id) : tasks.filter(t => t.status !== 'completed');
        if (matches.length !== 1)
            throw new Error(`Select --task; candidates: ${tasks.map(t => t.id).join(', ') || 'none; run start first'}`);
        const t = matches[0]!;
        if (t.version !== 1)
            throw new Error('Unsupported task protocol');
        return t;
    }
    private selected(s: ReturnType<AgentEngine['snapshot']>, t: Task) { return s.items.filter(i => t.files.includes(i.file_path)); }
    private assetHash(s: ReturnType<AgentEngine['snapshot']>, files: string[]) { return hash(s.assets.filter(a => files.includes(a.path)).map(a => ({ path: a.path, type: a.file_type, hash: hash(a.content) }))); }
    private basis(s: ReturnType<AgentEngine['snapshot']>, t: Task) {
        const settings = Object.fromEntries(Object.entries(s.meta).filter(([k]) => !k.startsWith(PREFIX) && !['updated_at', 'created_at', 'translation_extras', 'applied_writeback_migrations', 'name'].includes(k) && !k.startsWith('project_runtime_revision.') && !k.startsWith('proofreading_revision.')));
        return hash({ quality: s.quality, prompts: s.prompts, settings, source: t.source_language, target: t.target_language, clean_ruby: t.clean_ruby });
    }
    private assertAssets(s: ReturnType<AgentEngine['snapshot']>, t: Task) {
        if (this.assetHash(s, t.files) !== t.assets_hash)
            throw new Error('Source assets changed; start a new task for the affected scope');
    }
    private processing(s: ReturnType<AgentEngine['snapshot']>, t: Task) {
        const languages = read_project_language_settings(s.meta);
        if (languages.source_language !== t.source_language || languages.target_language !== t.target_language)
            throw new Error('Project languages changed; start a new task with the current languages');
        const config = normalize_text_processing_config({ ...languages, clean_ruby: t.clean_ruby });
        const quality = read_text_quality_snapshot({ quality: s.quality, prompts: s.prompts });
        return { config, quality, pre: new TranslationPrePipeline(config, quality), post: new TranslationPostPipeline(config, quality) };
    }
    private evaluation(s: ReturnType<AgentEngine['snapshot']>, t: Task, item: Item) {
        return evaluateProofreadingItem({ item: { ...build_project_item_public_record(item), internal_file_path: null }, quality: s.quality, quality_context: buildProofreadingEvaluationContext(s.quality), processingConfig: this.processing(s, t).config, sample_rule_cache: new Map() });
    }
    private progress(s: ReturnType<AgentEngine['snapshot']>, t: Task) {
        this.assertAssets(s, t);
        this.processing(s, t);
        const basis = this.basis(s, t);
        const items = this.selected(s, t);
        const translations = items.filter(i => i.status === 'NONE' || (i.status === 'ERROR' && t.retry_errors) || (t.retranslate && i.status === 'PROCESSED' && s.meta[`${PREFIX}translated.${t.id}.${i.id}`] !== hash(i)));
        const errors = items.filter(i => i.status === 'ERROR' && !t.retry_errors);
        const reviews = items.filter(i => {
            if (i.status !== 'PROCESSED')
                return false;
            const r = s.meta[`${PREFIX}review.${t.id}.${i.id}`] as unknown as Review | undefined;
            return !r || r.basis !== basis || r.fp !== hash(i) || r.verdict !== 'pass';
        });
        let stage = !t.terms_done ? 'terms' : translations.length ? 'translation' : errors.length ? 'blocked' : t.workflow === 'full' && reviews.length ? 'review' : 'export';
        const exported = s.meta[PREFIX + 'export.' + t.id] as unknown as {
            version: number;
            basis: string;
            items_hash: string;
            output: string;
            files: {
                file: string;
                hash: string;
            }[];
        } | undefined;
        if (stage === 'export' && exported?.version === 1 && exported.basis === basis && exported.items_hash === hash(items)) {
            try {
                if (exported.files.every(f => hash(readFileSync(path.join(exported.output, f.file))) === f.hash))
                    stage = 'completed';
            }
            catch (error) {
                if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? ''))
                    throw error;
            }
        }
        return { basis, translations, errors, reviews, stage, counts: Object.fromEntries(['NONE', 'PROCESSED', 'ERROR', 'EXCLUDED', 'RULE_SKIPPED', 'LANGUAGE_SKIPPED', 'DUPLICATED'].map(st => [st, items.filter(i => i.status === st).length])) };
    }
    async import(input: string, source = 'ALL', target = 'ZH') {
        const parsed = await readInput(input);
        const config = normalize_text_processing_config({ source_language: source, target_language: target, clean_ruby: false });
        const defaults = read_project_prefilter_settings({});
        const publicItems = Object.fromEntries(parsed.items.map((item, index) => [String(index + 1), build_project_item_public_record({ ...item, id: index + 1 })]));
        const filtered = compute_project_prefilter_write({ state: { files: build_project_file_records(parsed.assets), items: publicItems }, source_language: config.source_language, ...defaults });
        const items = Object.values(filtered.items).map(i => create_item({ ...i, id: i.item_id, row: i.row_number }));
        await this.database.create_project(this.project, path.basename(this.project, '.lg'), writer => {
            for (const asset of parsed.assets)
                writer.add_asset(this.project, asset.path, asset.content, asset.file_type, null, asset.sort_order);
            writer.set_items(this.project, items);
            writer.upsert_meta_entries(this.project, { source_language: config.source_language, target_language: config.target_language, ...defaults, translation_extras: json(filtered.translation_extras), prefilter_config: json(filtered.prefilter_config) });
            writer.bump_section_revisions(this.project, ['project', 'files', 'items']);
        });
        return this.inspect();
    }
    async inspect() { return this.database.read(this.project, w => { const s = this.snapshot(w); return { project: this.project, formats: FORMATS, files: s.assets.map(({ content, ...a }) => a), items: s.items.length, states: Object.fromEntries([...new Set(s.items.map(i => i.status))].map(st => [st, s.items.filter(i => i.status === st).length])), languages: read_project_language_settings(s.meta), tasks: Object.entries(s.meta).filter(([k]) => k.startsWith(PREFIX + 'task.')).map(([, v]) => v) }; }); }
    async start(options: {
        files?: string[];
        workflow?: Workflow;
        source_language?: string;
        target_language?: string;
        retry_errors?: boolean;
        retranslate?: boolean;
        clean_ruby?: boolean;
    } = {}) {
        return this.database.transaction(this.project, w => {
            const s = this.snapshot(w);
            const files = options.files ?? s.assets.map(a => a.path);
            if (!files.length || new Set(files).size !== files.length)
                throw new Error('Task scope must contain distinct files');
            for (const file of files) {
                const a = s.assets.find(a => a.path === file);
                if (!a || !FORMATS.includes(a.file_type as typeof FORMATS[number]))
                    throw new Error(`Unsupported/missing file: ${file}; select a supported subset with --files`);
            }
            if (this.selected(s, { files } as Task).some(i => !FORMATS.includes(i.file_type as typeof FORMATS[number])))
                throw new Error('Unsupported item in selected scope');
            const languages = read_project_language_settings(s.meta);
            const requested = normalize_text_processing_config({ source_language: options.source_language ?? languages.source_language, target_language: options.target_language ?? languages.target_language, clean_ruby: options.clean_ruby ?? false });
            if (requested.source_language !== languages.source_language || requested.target_language !== languages.target_language)
                throw new Error('Task languages must match the project; choose languages at import');
            if (options.workflow && !['full', 'translate'].includes(options.workflow))
                throw new Error('Unknown workflow');
            const t: Task = { version: 1, id: randomUUID(), created_at: new Date().toISOString(), files, workflow: options.workflow ?? 'full', ...languages, retry_errors: options.retry_errors ?? false, retranslate: options.retranslate ?? false, clean_ruby: requested.clean_ruby, deduplication_in_bilingual: true, write_translated_name_fields_to_file: true, assets_hash: this.assetHash(s, files), terms_done: options.workflow === 'translate', stage: 'terms', status: 'active' };
            w.set_meta(this.project, PREFIX + 'task.' + t.id, json(t));
            return t;
        });
    }
    async resume(id?: string) {
        return this.database.transaction(this.project, w => { const s = this.snapshot(w), t = this.task(s.meta, id), p = this.progress(s, t); t.stage = p.stage; t.status = p.stage === 'completed' ? 'completed' : p.stage === 'blocked' ? 'needs_input' : 'active'; w.set_meta(this.project, PREFIX + 'task.' + t.id, json(t)); return { task: t, counts: p.counts, remaining_translation: p.translations.length, remaining_review: p.reviews.length, errors: p.errors.map(i => i.id), quality: s.quality, terms: s.meta[PREFIX + 'terms.' + t.id] ?? null, pause: s.meta[PREFIX + 'pause.' + t.id] ?? null, next: p.stage }; });
    }
    async next(id?: string, limit = 20) {
        if (!Number.isInteger(limit) || limit < 1 || limit > 200)
            throw new Error('Batch limit must be 1..200');
        return this.database.transaction(this.project, w => {
            const s = this.snapshot(w), t = this.task(s.meta, id), p = this.progress(s, t);
            const chosen = (p.stage === 'translation' ? p.translations : p.stage === 'review' ? p.reviews : p.stage === 'terms' ? this.selected(s, t) : []).slice(0, limit);
            const batch: Batch = { version: 1, id: randomUUID(), task: t.id, phase: p.stage, basis: p.basis, ids: chosen.map(i => i.id!), fps: Object.fromEntries(chosen.map(i => [i.id!, String(workspaceItem(i).fp)])), inputs: chosen, state: 'prepared', created_at: new Date().toISOString() };
            const pipe = this.processing(s, t);
            const items = chosen.map((item, index) => ({ ...workspaceItem(item), previous_review: s.meta[`${PREFIX}review.${t.id}.${item.id}`] ?? null, request: p.stage === 'translation' ? pipe.pre.process_item(item, index, index).request_item : null, quality: this.evaluation(s, t, item), context: this.selected(s, t).filter(i => i.file_path === item.file_path && Math.abs(i.row - item.row) <= 2).map(i => ({ item_id: i.id, src: i.src, dst: i.dst, status: i.status })) }));
            w.set_meta(this.project, PREFIX + 'batch.' + batch.id, json(batch));
            t.stage = p.stage;
            t.status = p.stage === 'completed' ? 'completed' : p.stage === 'blocked' ? 'needs_input' : 'active';
            w.set_meta(this.project, PREFIX + 'task.' + t.id, json(t));
            return { task: t.id, attempt: batch.id, phase: batch.phase, languages: read_project_language_settings(s.meta), workflow: t.workflow, counts: p.counts, terms: s.meta[PREFIX + 'terms.' + t.id] ?? null, items, quality: Object.fromEntries(QUALITY_RULE_KINDS.map(k => [k, { ...s.quality[k], entries: s.quality[k].entries.map((e, n) => project_agent_workspace_quality_entry(k, e, n)) }])), prompts: s.prompts };
        });
    }
    async query(id?: string) { return this.database.read(this.project, w => { const s = this.snapshot(w), t = this.task(s.meta, id); return { task: t, items: this.selected(s, t).map(i => ({ ...workspaceItem(i), quality: this.evaluation(s, t, i) })), quality: s.quality, terms: s.meta[PREFIX + 'terms.' + t.id] ?? null }; }); }
    async apply(id: string | undefined, attempt: string, payload: unknown) {
        const body = record(payload);
        keys(body, ['items', 'translations', 'quality', 'reviews', 'terms']);
        const payload_hash = hash(body);
        const receiptKey = PREFIX + 'receipt.' + attempt;
        const before = await this.database.read(this.project, w => { const s = this.snapshot(w), t = this.task(s.meta, id); return { s, t, old: s.meta[receiptKey] as unknown as Receipt | undefined, batch: s.meta[PREFIX + 'batch.' + attempt] as unknown as Batch | undefined }; });
        const replay = (r: Receipt) => {
            if (r.version !== 1 || r.task !== before.t.id || r.payload_hash !== payload_hash)
                throw new Error('Attempt ID reused with different content or task');
            return { ...r, replayed: true };
        };
        if (before.old)
            return replay(before.old);
        const batch = before.batch;
        if (!batch || batch.version !== 1 || batch.task !== before.t.id)
            throw new Error('Unknown attempt; call next first');
        const rejected: Record<string, unknown>[] = [];
        const intents = create_empty_agent_workspace_intent_batch();
        const items: AgentWorkspaceIntentBatch['items'][number][] = [];
        const reviewRows: {
            item_id: number;
            fp: string;
            verdict: 'pass' | 'needs_revision';
            note: string;
        }[] = [];
        const array = (name: string): unknown[] => {
            const value = body[name] ?? [];
            if (!Array.isArray(value))
                throw new Error(`${name} must be an array`);
            return value;
        };
        const reject = (scope: string, line: number, error: unknown, item_id?: unknown) => rejected.push({ scope, line, item_id, reason: 'invalid_change', message: error instanceof Error ? error.message : String(error) });
        const assertScope = (row: Record<string, unknown>) => {
            if (!Number.isInteger(row.item_id) || !batch.ids.includes(row.item_id as number))
                throw new Error('Item outside prepared batch');
            if (typeof row.fp !== 'string' || row.fp !== batch.fps[String(row.item_id)])
                throw new Error('Fingerprint differs from prepared batch');
        };
        if ((array('items').length || array('translations').length) && !['translation', 'review'].includes(batch.phase))
            throw new Error('This batch is not an item-edit phase');
        for (const [index, value] of array('items').entries()) {
            let row: Record<string, unknown> = {};
            try {
                row = record(value);
                assertScope(row);
                const { item_id, fp, ...update } = row;
                if (!Check(PROJECT_ITEM_MANUAL_UPDATE_SCHEMA, update))
                    throw new Error('Invalid original Item update');
                items.push({ line: index + 1, item_id: item_id as number, fp: fp as string, update });
            }
            catch (e) {
                reject('items', index + 1, e, row.item_id);
            }
        }
        const pipeline = this.processing(before.s, before.t);
        const prepared = new Map(batch.ids.map((item_id, index) => { const item = batch.inputs?.find(i => i.id === item_id); return [item_id, item ? pipeline.pre.process_item(item, index, index) : null]; }));
        for (const [index, value] of array('translations').entries()) {
            let row: Record<string, unknown> = {};
            try {
                row = record(value);
                keys(row, ['item_id', 'fp', 'text_dst', 'actor_dst']);
                assertScope(row);
                if (batch.phase !== 'translation')
                    throw new Error('Use items for manual review corrections; translations are only for prepared model requests');
                const ctx = prepared.get(row.item_id as number);
                if (!ctx)
                    throw new Error('Missing item');
                const output = pipeline.post.process_item(ctx, { request_id: ctx.request_item?.request_id ?? 0, text_dst: text(row.text_dst, 'text_dst'), actor_dst: row.actor_dst == null ? null : text(row.actor_dst, 'actor_dst') });
                const original = before.s.items.find(i => i.id === row.item_id)!;
                const updated = create_item({ ...original, ...output, status: 'PROCESSED' });
                const warnings = this.evaluation(before.s, before.t, updated).warnings.filter(w => w.code === 'TEXT_PRESERVE' || w.code === 'LINE_COUNT_MISMATCH');
                if (warnings.length)
                    throw new Error(`Structural check failed: ${JSON.stringify(warnings)}`);
                items.push({ line: index + 1, item_id: row.item_id as number, fp: row.fp as string, update: { dst: output.dst, ...(output.name_dst == null ? {} : { name_dst: output.name_dst }), status: 'PROCESSED' } });
            }
            catch (e) {
                reject('translations', index + 1, e, row.item_id);
            }
        }
        for (const [index, value] of array('reviews').entries()) {
            let row: Record<string, unknown> = {};
            try {
                row = record(value);
                keys(row, ['item_id', 'fp', 'verdict', 'note']);
                assertScope(row);
                if (batch.phase !== 'review')
                    throw new Error('Review requires a review batch');
                if (row.verdict !== 'pass' && row.verdict !== 'needs_revision')
                    throw new Error('Invalid review verdict');
                reviewRows.push({ item_id: row.item_id as number, fp: row.fp as string, verdict: row.verdict, note: text(row.note, 'note') });
            }
            catch (e) {
                reject('reviews', index + 1, e, row.item_id);
            }
        }
        const quality = { ...intents.quality };
        if (body.quality !== undefined) {
            if (Object.keys(record(body.quality)).length > 0 && (items.length || reviewRows.length))
                throw new Error('Submit rules separately, then prepare a fresh translation/review batch');
            const input = record(body.quality);
            keys(input, QUALITY_RULE_KINDS);
            for (const kind of QUALITY_RULE_KINDS)
                if (input[kind] !== undefined) {
                    const ops = record(input[kind]);
                    keys(ops, ['creates', 'updates', 'deletes']);
                    const creates: typeof quality[typeof kind]['creates'][number][] = [], updates: typeof quality[typeof kind]['updates'][number][] = [], deletes: typeof quality[typeof kind]['deletes'][number][] = [];
                    for (const op of ['creates', 'updates', 'deletes'] as const) {
                        const rows = ops[op] ?? [];
                        if (!Array.isArray(rows))
                            throw new Error(`${kind}.${op} must be an array`);
                        for (const [index, value] of rows.entries())
                            try {
                                if (!Check(AGENT_WORKSPACE_QUALITY_SCHEMAS[kind][op], value))
                                    throw new Error(`Invalid ${kind} ${op} record`);
                                const row = record(value);
                                const { id: entryId, fp, sort, ...fields } = row;
                                if (op === 'creates')
                                    creates.push({ line: index + 1, kind, sort: sort as number, fields: fields as JsonRecord });
                                if (op === 'updates')
                                    updates.push({ line: index + 1, kind, id: entryId as string, fp: fp as string, fields: fields as JsonRecord, ...(sort === undefined ? {} : { sort: sort as number }) });
                                if (op === 'deletes')
                                    deletes.push({ line: index + 1, kind, id: entryId as string, fp: fp as string });
                            }
                            catch (e) {
                                reject('quality', index + 1, e);
                            }
                    }
                    quality[kind] = { creates, updates, deletes };
                }
        }
        let terms: Record<string, unknown> | undefined;
        if (body.terms !== undefined) {
            terms = record(body.terms);
            keys(terms, ['done', 'sources', 'notes', 'candidates']);
            if (typeof terms.done !== 'boolean')
                throw new Error('terms.done must be boolean');
            if (batch.phase !== 'terms')
                throw new Error('Terminology checkpoint requires a terms batch');
        }
        const finalBatch = { ...intents, items, quality };
        let receipt: Receipt | undefined;
        let replayed: Receipt | undefined;
        const validReviews: typeof reviewRows = [];
        try {
            await this.store.apply_agent_workspace_changes({ projectPath: this.project, source: 'agent_workspace_apply', batch: finalBatch,
                guard: w => {
                    const s = this.snapshot(w);
                    const old = s.meta[receiptKey] as unknown as Receipt | undefined;
                    if (old) {
                        replay(old);
                        replayed = old;
                        throw new Error('receipt_already_committed');
                    }
                    const t = this.task(s.meta, before.t.id);
                    this.assertAssets(s, t);
                    this.processing(s, t);
                    if (this.basis(s, t) !== batch.basis)
                        throw new Error('Rules or configuration changed; prepare a fresh batch');
                    for (const r of reviewRows) {
                        const current = s.items.find(i => i.id === r.item_id);
                        if (!current || workspaceItem(current).fp !== r.fp)
                            rejected.push({ scope: 'reviews', item_id: r.item_id, reason: 'fp_mismatch' });
                        else
                            validReviews.push(r);
                    }
                },
                checkpoint: (w, change, outcome) => {
                    const allRejected = [...rejected, ...outcome.rejected];
                    const reviewed_item_ids: number[] = [];
                    const s = this.snapshot(w), t = this.task(s.meta, before.t.id);
                    for (const r of validReviews) {
                        const failed = allRejected.some(e => e.item_id === r.item_id || e.id === r.item_id);
                        const item = s.items.find(i => i.id === r.item_id)!;
                        if (failed || item.status !== 'PROCESSED') {
                            allRejected.push({ scope: 'reviews', item_id: r.item_id, reason: 'dependency_conflict' });
                            continue;
                        }
                        w.set_meta(this.project, `${PREFIX}review.${t.id}.${r.item_id}`, json({ version: 1, fp: hash(item), basis: this.basis(s, t), verdict: r.verdict, note: r.note }));
                        reviewed_item_ids.push(r.item_id);
                    }
                    // Record only accepted target facts. Duplicate coordination still belongs to the original store.
                    for (const intent of items)
                        if (!outcome.rejected.some(e => e.item_id === intent.item_id || e.id === intent.item_id)) {
                            const item = s.items.find(i => i.id === intent.item_id);
                            if (item?.status === 'PROCESSED')
                                w.set_meta(this.project, `${PREFIX}translated.${t.id}.${intent.item_id}`, hash(item));
                        }
                    if (terms) {
                        w.set_meta(this.project, `${PREFIX}terms.${t.id}`, json(terms));
                        if (terms.done && allRejected.length === 0)
                            t.terms_done = true;
                    }
                    const businessChanged = Object.keys(outcome.applied).length > 0;
                    receipt = { version: 1, attempt, task: t.id, payload_hash, status: allRejected.length ? (businessChanged ? 'partial' : 'rejected') : (businessChanged ? 'applied' : 'unchanged'), applied: outcome.applied, rejected: allRejected, section_revisions: change.sectionRevisions,
                        item_results: [...new Set([...items.map(i => i.item_id), ...rejected.map(r => r.item_id).filter((id): id is number => typeof id === 'number')])].map(item_id => ({ item_id, accepted: items.some(i => i.item_id === item_id) && !outcome.rejected.some(r => r.id === item_id || r.item_id === item_id), changed: outcome.itemChanges.some(i => i.item_id === item_id), rejected_records: allRejected.some(r => r.id === item_id || r.item_id === item_id) })),
                        reviewed_item_ids,
                        quality_entry_ids_after: Object.fromEntries(outcome.qualityChanges.map(change => [change.kind, change.entries.map(entry => String(entry.entry_id))])),
                        checkpoint_saved: true
                    };
                    w.set_meta(this.project, receiptKey, json(receipt));
                    w.set_meta(this.project, PREFIX + 'batch.' + attempt, json({ ...batch, state: 'committed' }));
                    t.status = 'active';
                    w.set_meta(this.project, PREFIX + 'task.' + t.id, json(t));
                    const progress = this.progress(this.snapshot(w), t);
                    t.stage = progress.stage;
                    t.status = progress.stage === 'completed' ? 'completed' : progress.stage === 'blocked' ? 'needs_input' : 'active';
                    w.set_meta(this.project, PREFIX + 'task.' + t.id, json(t));
                    // Test hooks never apply unless explicitly injected by the integration suite.
                    this.beforeCommitTestHook?.();
                }
            });
        }
        catch (e) {
            if (replayed)
                return { ...replayed, replayed: true };
            throw e;
        }
        this.afterCommitTestHook?.();
        return receipt!;
    }
    beforeCommitTestHook?: () => void;
    afterCommitTestHook?: () => void;
    async configure(kind: QualityRuleKind, value: unknown) {
        if (!QUALITY_RULE_KINDS.includes(kind))
            throw new Error('Unknown quality rule kind');
        const rule = QualityRule.from_json(kind);
        const patch = record(value);
        keys(patch, kind === 'text_preserve' ? ['mode'] : ['enabled']);
        if (kind === 'text_preserve' && !['off', 'smart', 'custom'].includes(String(patch.mode)))
            throw new Error('Invalid protection mode');
        if (kind !== 'text_preserve' && typeof patch.enabled !== 'boolean')
            throw new Error('enabled must be boolean');
        const revisions = await this.database.read(this.project, w => new ProjectDataReader(w).build_section_revisions(w.get_all_meta(this.project)));
        return this.store.save_quality_rules({ projectPath: this.project, expectedSectionRevisions: revisions, source: 'agent_configure', revisionKey: rule.revision_meta_key, metaEntries: { [kind === 'text_preserve' ? rule.mode_meta_key! : rule.enabled_meta_key!]: json(kind === 'text_preserve' ? patch.mode : patch.enabled) } });
    }
    async pause(id: string | undefined, reason: string) {
        return this.database.transaction(this.project, w => { const t = this.task(w.get_all_meta(this.project), id); t.status = 'paused'; w.set_meta(this.project, PREFIX + 'task.' + t.id, json(t)); w.set_meta(this.project, PREFIX + 'pause.' + t.id, json({ version: 1, reason, at: new Date().toISOString() })); return t; });
    }
    async receipt(attempt: string) { return this.database.read(this.project, w => w.get_all_meta(this.project)[PREFIX + 'receipt.' + attempt] ?? null); }
    async export(id: string | undefined, output: string) {
        const captured = await this.database.read(this.project, w => { const s = this.snapshot(w), t = this.task(s.meta, id); this.assertAssets(s, t); return { s, t, p: this.progress(s, t) }; });
        const { s, t, p } = captured;
        const assets = s.assets.filter(a => t.files.includes(a.path));
        const destination = path.resolve(output);
        const projectRelative = path.relative(destination, this.project);
        if (!projectRelative.startsWith('..') && !path.isAbsolute(projectRelative))
            throw new Error('Output cannot contain the project database');
        const files = await generate(assets, this.selected(s, t), destination, { ...defaultConfig, target_language: t.target_language, deduplication_in_bilingual: t.deduplication_in_bilingual, write_translated_name_fields_to_file: t.write_translated_name_fields_to_file });
        const outputs = await Promise.all(files.map(async (file) => ({ file, hash: hash(await fs.readFile(path.join(destination, file))) })));
        return this.database.transaction(this.project, w => {
            const latest = this.snapshot(w);
            const current = this.task(latest.meta, t.id);
            if (hash(this.selected(latest, current)) !== hash(this.selected(s, t)) || this.basis(latest, current) !== p.basis || this.assetHash(latest, t.files) !== t.assets_hash)
                throw new Error('Project changed while exporting; regenerate output');
            const progress = this.progress(latest, current);
            const exportRecord = { version: 1, basis: p.basis, items_hash: hash(this.selected(s, t)), output: destination, files: outputs, created_at: new Date().toISOString() };
            w.set_meta(this.project, PREFIX + 'export.' + t.id, json(exportRecord));
            current.status = ['export', 'completed'].includes(progress.stage) ? 'completed' : 'active';
            current.stage = current.status === 'completed' ? 'completed' : progress.stage;
            w.set_meta(this.project, PREFIX + 'task.' + t.id, json(current));
            return { task: current.id, status: current.status, output: destination, files: outputs, counts: progress.counts, zero_item_assets: assets.filter(a => !this.selected(s, t).some(i => i.file_path === a.path)).map(a => a.path), fallback_items: this.selected(s, t).filter(i => i.status !== 'PROCESSED').map(i => i.id) };
        });
    }
}
