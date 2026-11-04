import type { DatabaseSync } from "node:sqlite";

export interface DatabaseWritebackMigration {
  readonly id: string;
  readonly run: (db: DatabaseSync) => void;
}
