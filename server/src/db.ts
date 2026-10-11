// SQLite document store: every entity is a JSON row keyed by (kind, id), scoped to a workspace where relevant.
import { DatabaseSync } from 'node:sqlite';
import { config } from './config.ts';

const db = new DatabaseSync(config.dbPath);
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS docs (
    kind TEXT NOT NULL, id TEXT NOT NULL, workspace_id TEXT, json TEXT NOT NULL, updated_at TEXT NOT NULL,
    PRIMARY KEY (kind, id)
  );
  CREATE INDEX IF NOT EXISTS docs_ws ON docs (kind, workspace_id);
`);

export type Kind = 'workspace' | 'connection' | 'incident' | 'decision' | 'playbook' | 'stats' | 'agent-transcript' | 'research' | 'view';

const putStmt = db.prepare(
  `INSERT INTO docs (kind, id, workspace_id, json, updated_at) VALUES (?, ?, ?, ?, ?)
   ON CONFLICT (kind, id) DO UPDATE SET workspace_id = excluded.workspace_id, json = excluded.json, updated_at = excluded.updated_at`);
const getStmt = db.prepare(`SELECT json FROM docs WHERE kind = ? AND id = ?`);
const listStmt = db.prepare(`SELECT json FROM docs WHERE kind = ? ORDER BY updated_at`);
const listWsStmt = db.prepare(`SELECT json FROM docs WHERE kind = ? AND workspace_id = ? ORDER BY updated_at`);
const delStmt = db.prepare(`DELETE FROM docs WHERE kind = ? AND id = ?`);
const delWsStmt = db.prepare(`DELETE FROM docs WHERE kind = ? AND workspace_id = ?`);

export const store = {
  put<T extends { id: string }>(kind: Kind, doc: T, workspaceId?: string | null): T {
    putStmt.run(kind, doc.id, workspaceId ?? null, JSON.stringify(doc), new Date().toISOString());
    return doc;
  },
  get<T>(kind: Kind, id: string): T | undefined {
    const row = getStmt.get(kind, id) as { json: string } | undefined;
    return row ? (JSON.parse(row.json) as T) : undefined;
  },
  list<T>(kind: Kind, workspaceId?: string): T[] {
    const rows = (workspaceId ? listWsStmt.all(kind, workspaceId) : listStmt.all(kind)) as { json: string }[];
    return rows.map(r => JSON.parse(r.json) as T);
  },
  delete(kind: Kind, id: string) { delStmt.run(kind, id); },
  deleteForWorkspace(kind: Kind, workspaceId: string) { delWsStmt.run(kind, workspaceId); },
};
