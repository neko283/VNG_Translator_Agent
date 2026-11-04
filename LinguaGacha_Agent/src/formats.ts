import fs from 'node:fs/promises';
import path from 'node:path';
import { TXTFormat } from '../upstream/src/backend/file/txt/txt-format';
import { KVJSONFormat } from '../upstream/src/backend/file/kvjson/kvjson-format';
import { MESSAGEJSONFormat } from '../upstream/src/backend/file/messagejson/messagejson-format';
import { decode_text_content } from '../upstream/src/shared/utils/text-tool';
import { assert_source_file_paths } from '../upstream/src/backend/file/source-file-paths';
import { build_project_item_duplicate_key } from '../upstream/src/shared/project/project-item-duplicates';
import type { Item } from '../upstream/src/domain/item';
import type { FileFormatServiceConfig } from '../upstream/src/backend/file/file-format-types';
export const FORMATS = ['TXT', 'KVJSON', 'MESSAGEJSON'] as const;
export interface Asset {
    path: string;
    file_type: string;
    sort_order: number;
    content: Buffer;
}
export const defaultConfig: FileFormatServiceConfig = { target_language: 'ZH', deduplication_in_bilingual: true, write_translated_name_fields_to_file: true };
export async function readInput(input: string): Promise<{
    assets: Asset[];
    items: Item[];
}> {
    const entry = await fs.lstat(input);
    if (entry.isSymbolicLink())
        throw new Error('Input symlinks are not supported');
    const root = entry.isDirectory() ? path.resolve(input) : path.dirname(path.resolve(input));
    const files: string[] = [];
    async function visit(file: string) {
        const stat = await fs.lstat(file);
        if (stat.isSymbolicLink())
            throw new Error(`Input symlink: ${file}`);
        if (stat.isDirectory()) {
            for (const name of (await fs.readdir(file)).sort())
                await visit(path.join(file, name));
        }
        else if (stat.isFile())
            files.push(file);
        else
            throw new Error(`Not a regular input: ${file}`);
    }
    await visit(path.resolve(input));
    const assets: Asset[] = [];
    const items: Item[] = [];
    for (const file of files) {
        const relative = path.relative(root, file).split(path.sep).join('/');
        const content = await fs.readFile(file);
        let parsed: Item[];
        let file_type: string;
        if (path.extname(file).toLowerCase() === '.txt') {
            file_type = 'TXT';
            parsed = await new TXTFormat(defaultConfig).read_from_stream(content, relative);
        }
        else if (path.extname(file).toLowerCase() === '.json') {
            const data = JSON.parse(await decode_text_content(content));
            if (Array.isArray(data)) {
                file_type = 'MESSAGEJSON';
                parsed = new MESSAGEJSONFormat(defaultConfig).read_items(data, relative);
            }
            else if (data !== null && typeof data === 'object') {
                file_type = 'KVJSON';
                parsed = new KVJSONFormat().read_items(data, relative);
            }
            else
                throw new Error(`Unsupported JSON structure: ${relative}`);
        }
        else
            throw new Error(`Unsupported input format: ${relative}. Only TXT, KV-JSON and Message-JSON are supported.`);
        assets.push({ path: relative, file_type, sort_order: assets.length, content });
        items.push(...parsed);
    }
    if (!assets.length)
        throw new Error('Input contains no files');
    assert_source_file_paths(assets);
    return { assets, items };
}
export async function generate(assets: Asset[], input: Item[], output: string, config = defaultConfig): Promise<string[]> {
    assert_source_file_paths(assets);
    if (assets.some(a => !FORMATS.includes(a.file_type as typeof FORMATS[number])))
        throw new Error('Unsupported export format');
    // Extracted from TranslationFileGenerationService: duplicates only change the export copy.
    const items = structuredClone(input);
    const translations = new Map<string, Item>();
    for (const item of items)
        if (item.status === 'PROCESSED' && !translations.has(build_project_item_duplicate_key(item)))
            translations.set(build_project_item_duplicate_key(item), item);
    for (const item of items)
        if (item.status === 'DUPLICATED') {
            const original = translations.get(build_project_item_duplicate_key(item));
            if (original) {
                item.dst = original.dst;
                item.name_dst = original.name_dst;
                item.status = 'PROCESSED';
            }
        }
    const paths = { translated_path: output, bilingual_path: path.join(output, 'bilingual') };
    const planned = assets.filter(a => items.some(i => i.file_path === a.path)).flatMap(a => a.file_type === 'TXT' ? [a.path, `bilingual/${a.path}`] : [a.path]);
    // Bilingual paths share the output root; reject collisions before writing anything.
    assert_source_file_paths(planned.map(p => ({ path: p, file_type: 'TXT' })));
    for (const rel of planned) {
        let cursor = path.resolve(output, rel);
        while (cursor !== path.dirname(cursor)) {
            try {
                if ((await fs.lstat(cursor)).isSymbolicLink())
                    throw new Error(`Output symlink: ${cursor}`);
            }
            catch (e) {
                if ((e as NodeJS.ErrnoException).code !== 'ENOENT')
                    throw e;
            }
            cursor = path.dirname(cursor);
        }
    }
    await new TXTFormat(config).write_to_path(items, paths);
    await new KVJSONFormat().write_to_path(items, paths, rel => assets.find(a => a.path === rel)?.content ?? null);
    await new MESSAGEJSONFormat(config).write_to_path(items, paths);
    return planned;
}
