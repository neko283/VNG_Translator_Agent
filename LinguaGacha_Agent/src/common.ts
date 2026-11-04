import { createHash } from 'node:crypto';
import type { JsonValue } from '../upstream/src/domain/json';
export const PREFIX = 'linguagacha_agent.';
export function hash(value: unknown): string {
    function stable(x: unknown): unknown {
        if (Array.isArray(x))
            return x.map(stable);
        if (x && typeof x === 'object')
            return Object.fromEntries(Object.entries(x).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, stable(v)]));
        return x;
    }
    return createHash('sha256').update(Buffer.isBuffer(value) ? value : JSON.stringify(stable(value))).digest('hex');
}
export function json(value: unknown): JsonValue { return JSON.parse(JSON.stringify(value)) as JsonValue; }
export function record(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new Error('Expected an object');
    return value as Record<string, unknown>;
}
export function keys(value: Record<string, unknown>, allowed: readonly string[]): void {
    for (const key of Object.keys(value))
        if (!allowed.includes(key))
            throw new Error(`Unknown field: ${key}`);
}
export function text(value: unknown, name: string): string {
    if (typeof value !== 'string')
        throw new Error(`${name} must be a string`);
    return value;
}
