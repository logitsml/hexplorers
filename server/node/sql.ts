// node:sqlite under the ports' interfaces: a room's synchronous SQL (as a Durable Object's
// ctx.storage.sql) and the service database (as D1, asynchronous). Rows written are counted the
// way Cloudflare bills them, so local runs and tests can report the cost.

import { DatabaseSync, type StatementSync } from 'node:sqlite';
import type { RoomSql, ServiceDb, SqlCursor, SqlValue } from '../core/ports';

class Cursor<T> implements SqlCursor<T> {
  constructor(
    private rows: T[],
    readonly rowsWritten: number,
  ) {}

  [Symbol.iterator]() {
    return this.rows[Symbol.iterator]();
  }

  toArray() {
    return this.rows;
  }

  one() {
    if (this.rows.length !== 1) throw new Error(`Expected one row, got ${this.rows.length}.`);
    return this.rows[0];
  }
}

const WRITES = /^\s*(insert|update|delete|replace)\b/i;

/** A room's SQL over one DatabaseSync (a file, or ':memory:' in tests). */
export class NodeSql implements RoomSql {
  private db: DatabaseSync | null = null;
  private statements = new Map<string, StatementSync>();
  /** Rows written since this was made (Cloudflare's bill counts these). */
  rowsWritten = 0;
  rowsRead = 0;
  /** Rows written by statement (its table and key), for reports. */
  readonly writesBy = new Map<string, number>();

  constructor(private path: string) {}

  private open(): DatabaseSync {
    if (!this.db) {
      this.db = new DatabaseSync(this.path);
      this.db.exec('PRAGMA synchronous = NORMAL');
    }
    return this.db;
  }

  exec<T = Record<string, SqlValue>>(query: string, ...bindings: SqlValue[]): SqlCursor<T> {
    const db = this.open();
    let st = this.statements.get(query);
    if (!st) {
      st = db.prepare(query);
      this.statements.set(query, st);
    }
    if (st.columns().length > 0) {
      const rows = st.all(...bindings) as T[];
      this.rowsRead += rows.length;
      return new Cursor(rows, 0);
    }
    const r = st.run(...bindings);
    const written = WRITES.test(query) ? Number(r.changes) : 0;
    this.rowsWritten += written;
    if (written) {
      const what = `${/(?:into|update|from)\s+(\w+)/i.exec(query)?.[1] ?? '?'}${typeof bindings[0] === 'string' && bindings[0].length < 12 ? `:${bindings[0]}` : ''}`;
      this.writesBy.set(what, (this.writesBy.get(what) ?? 0) + written);
    }
    return new Cursor<T>([], written);
  }

  /** Close the database (it opens again on the next statement). */
  close() {
    this.statements.clear();
    this.db?.close();
    this.db = null;
  }

  get isOpen() {
    return this.db !== null;
  }
}

/** The service database over node:sqlite, with D1's asynchronous shape. */
export class NodeServiceDb implements ServiceDb {
  private sql: NodeSql;

  constructor(path: string) {
    this.sql = new NodeSql(path);
    if (path !== ':memory:') this.sql.exec('PRAGMA journal_mode = WAL');
  }

  async all<T = Record<string, SqlValue>>(query: string, ...bindings: SqlValue[]): Promise<T[]> {
    return this.sql.exec<T>(query, ...bindings).toArray();
  }

  async first<T = Record<string, SqlValue>>(query: string, ...bindings: SqlValue[]): Promise<T | null> {
    return this.sql.exec<T>(query, ...bindings).toArray()[0] ?? null;
  }

  async run(query: string, ...bindings: SqlValue[]): Promise<{ changes: number; lastRowId: number }> {
    const c = this.sql.exec(query, ...bindings);
    const id = this.sql.exec<{ id: number }>('SELECT last_insert_rowid() AS id').toArray()[0]?.id ?? 0;
    return { changes: c.rowsWritten, lastRowId: Number(id) };
  }

  async batch(statements: { query: string; bindings: SqlValue[] }[]): Promise<void> {
    this.sql.exec('BEGIN');
    try {
      for (const s of statements) this.sql.exec(s.query, ...s.bindings);
      this.sql.exec('COMMIT');
    } catch (e) {
      this.sql.exec('ROLLBACK');
      throw e;
    }
  }

  close() {
    this.sql.close();
  }
}
