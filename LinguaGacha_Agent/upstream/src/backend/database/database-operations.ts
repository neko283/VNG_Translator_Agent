// Standalone adapter: original ProjectDatabaseAccess and migrations, no chat SDK or Electron.
import path from 'node:path';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { run_project_database_migrations } from '../migration/database-migrations';
import { ProjectDatabaseAccess } from './project-database-access';
export { ProjectDatabaseAccess } from './project-database-access';
export type { ProjectDatabaseWrite, ProjectAssetRecord, ProjectItemTranslationWrite } from './project-database-access';

const MIGRATIONS = ['project-rule-storage','quality-rule-entry-identity','project-item-stable-metadata','trans-item-metadata','project-item-public-contract','asset-file-type'];
export class ProjectDatabase {
  private connections = new Map<string, DatabaseSync>();
  async prepare(file: string): Promise<void> {
    file = path.resolve(file);
    if (this.connections.has(file)) return;
    if (!fs.existsSync(file)) throw new Error(`Project not found: ${file}`);
    const db = new DatabaseSync(file);
    try {
      db.exec('PRAGMA busy_timeout=5000');
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r=>r.name);
      if (!tables.includes('meta') || !tables.includes('items') || !tables.includes('assets')) throw new Error('Not a LinguaGacha project');
      const raw = db.prepare('SELECT value FROM meta WHERE key=?').get('applied_writeback_migrations');
      const applied: unknown = raw ? JSON.parse(String(raw.value)) : [];
      if (!Array.isArray(applied) || applied.some(x=>!MIGRATIONS.includes(x))) throw new Error('Unknown project migration version; writes refused');
      // VACUUM INTO takes a consistent SQLite snapshot, including live WAL contents.
      if (MIGRATIONS.some(x=>!applied.includes(x))) {
        const backup = `${file}.before-migration-${Date.now()}.lg`;
        db.exec(`VACUUM INTO '${backup.replaceAll("'", "''")}'`);
      }
      run_project_database_migrations(db);
      this.connections.set(file, db);
    } catch (error) { db.close(); throw error; }
  }
  async create_project(file: string, name: string, initialize?: (writer: ProjectDatabaseAccess)=>void): Promise<void> {
    file = path.resolve(file);
    fs.mkdirSync(path.dirname(file), {recursive:true});
    fs.closeSync(fs.openSync(file, 'wx'));
    const db = new DatabaseSync(file);
    try {
      db.exec('PRAGMA busy_timeout=5000');
      run_project_database_migrations(db);
      this.connections.set(file, db);
      await this.transaction(file, writer=> {
        const now = new Date().toISOString();
        writer.upsert_meta_entries(file, {name,created_at:now,updated_at:now});
        initialize?.(writer);
      });
    } catch (error) { this.connections.delete(file); db.close(); fs.unlinkSync(file); throw error; }
  }
  async read<T>(file: string, fn: (reader: ProjectDatabaseAccess)=>T): Promise<T> {
    await this.prepare(file);
    const db = this.connections.get(path.resolve(file))!;
    // Multi-table reads must observe one snapshot too.
    db.exec('BEGIN');
    const reader = new ProjectDatabaseAccess(path.resolve(file), db);
    try { const result = fn(reader); if (result instanceof Promise) throw new Error('Database callbacks must be synchronous'); db.exec('COMMIT'); return result; }
    catch(error) { db.exec('ROLLBACK'); throw error; }
    finally { reader.active=false; }
  }
  async transaction<T>(file: string, fn: (writer: ProjectDatabaseAccess)=>T): Promise<T> {
    await this.prepare(file);
    const db = this.connections.get(path.resolve(file))!;
    db.exec('BEGIN IMMEDIATE');
    const writer = new ProjectDatabaseAccess(path.resolve(file), db);
    try { const result=fn(writer); if(result instanceof Promise) throw new Error('Database callbacks must be synchronous'); db.exec('COMMIT'); return result; }
    catch(error) { db.exec('ROLLBACK'); throw error; }
    finally { writer.active=false; }
  }
  async close(): Promise<void> { for(const db of this.connections.values()) db.close(); this.connections.clear(); }
}
