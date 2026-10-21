import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

const DATA_DIR = path.resolve(process.cwd(), 'test-harness-data');

export interface Entity {
  id: string;
  service: string;
  entity_type: string;
  data: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export class EntityStore {
  private db: Database.Database;

  constructor(dbPath?: string) {
    const resolvedPath = dbPath ?? path.join(DATA_DIR, 'fake-channels.db');
    fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });

    this.db = new Database(resolvedPath);
    this.db.pragma('journal_mode = WAL');
    this.init();
  }

  private init() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS entities (
        id TEXT NOT NULL,
        service TEXT NOT NULL,
        entity_type TEXT NOT NULL,
        data JSON NOT NULL,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now')),
        PRIMARY KEY (service, entity_type, id)
      );

      CREATE INDEX IF NOT EXISTS idx_entities_service ON entities(service);
      CREATE INDEX IF NOT EXISTS idx_entities_service_type ON entities(service, entity_type);

      CREATE TABLE IF NOT EXISTS sequences (
        service TEXT NOT NULL,
        entity_type TEXT NOT NULL,
        next_val INTEGER NOT NULL DEFAULT 1,
        PRIMARY KEY (service, entity_type)
      );
    `);
  }

  nextId(service: string, entityType: string): string {
    const stmt = this.db.prepare(`
      INSERT INTO sequences (service, entity_type, next_val)
      VALUES (?, ?, 1)
      ON CONFLICT (service, entity_type)
      DO UPDATE SET next_val = next_val + 1
      RETURNING next_val
    `);
    const row = stmt.get(service, entityType) as { next_val: number };
    return String(row.next_val);
  }

  get(service: string, entityType: string, id: string): Entity | null {
    const row = this.db
      .prepare('SELECT * FROM entities WHERE service = ? AND entity_type = ? AND id = ?')
      .get(service, entityType, id) as (Omit<Entity, 'data'> & { data: string }) | undefined;
    if (!row) return null;
    return { ...row, data: JSON.parse(row.data) };
  }

  list(service: string, entityType: string): Entity[] {
    const rows = this.db
      .prepare('SELECT * FROM entities WHERE service = ? AND entity_type = ? ORDER BY created_at')
      .all(service, entityType) as (Omit<Entity, 'data'> & { data: string })[];
    return rows.map((r) => ({ ...r, data: JSON.parse(r.data) }));
  }

  listAll(service: string): Entity[] {
    const rows = this.db
      .prepare('SELECT * FROM entities WHERE service = ? ORDER BY entity_type, created_at')
      .all(service) as (Omit<Entity, 'data'> & { data: string })[];
    return rows.map((r) => ({ ...r, data: JSON.parse(r.data) }));
  }

  search(service: string, entityType: string, predicate: (data: Record<string, unknown>) => boolean): Entity[] {
    return this.list(service, entityType).filter((e) => predicate(e.data));
  }

  create(service: string, entityType: string, data: Record<string, unknown>, id?: string): Entity {
    const entityId = id ?? this.nextId(service, entityType);
    const now = new Date().toISOString();
    this.db
      .prepare(
        'INSERT OR REPLACE INTO entities (id, service, entity_type, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(entityId, service, entityType, JSON.stringify(data), now, now);
    return { id: entityId, service, entity_type: entityType, data, created_at: now, updated_at: now };
  }

  update(service: string, entityType: string, id: string, data: Record<string, unknown>): Entity | null {
    const existing = this.get(service, entityType, id);
    if (!existing) return null;
    const merged = { ...existing.data, ...data };
    const now = new Date().toISOString();
    this.db
      .prepare('UPDATE entities SET data = ?, updated_at = ? WHERE service = ? AND entity_type = ? AND id = ?')
      .run(JSON.stringify(merged), now, service, entityType, id);
    return { ...existing, data: merged, updated_at: now };
  }

  delete(service: string, entityType: string, id: string): void {
    this.db.prepare('DELETE FROM entities WHERE service = ? AND entity_type = ? AND id = ?').run(service, entityType, id);
  }

  deleteService(service: string): void {
    this.db.prepare('DELETE FROM entities WHERE service = ?').run(service);
    this.db.prepare('DELETE FROM sequences WHERE service = ?').run(service);
  }

  deleteAll(): void {
    this.db.prepare('DELETE FROM entities').run();
    this.db.prepare('DELETE FROM sequences').run();
  }
}
