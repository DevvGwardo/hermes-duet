import { DatabaseSync, type SQLInputValue, type StatementSync } from 'node:sqlite';

type NamedParams = Record<string, SQLInputValue>;

function normalizeValue(v: unknown): SQLInputValue {
  if (v === undefined || v === null) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  return v as SQLInputValue;
}

function isNamedObject(arg: unknown): arg is Record<string, unknown> {
  return (
    typeof arg === 'object' &&
    arg !== null &&
    !Array.isArray(arg) &&
    !(arg instanceof Uint8Array) &&
    !ArrayBuffer.isView(arg)
  );
}

function invokeStmt<T>(
  stmt: StatementSync,
  method: 'get' | 'all' | 'run',
  args: unknown[],
): T {
  if (args.length === 1 && isNamedObject(args[0])) {
    const named: NamedParams = {};
    for (const [k, v] of Object.entries(args[0])) {
      named[k] = normalizeValue(v);
    }
    return (stmt[method] as unknown as (p: NamedParams) => T)(named);
  }
  const pos = args.map(normalizeValue);
  return (stmt[method] as unknown as (...p: SQLInputValue[]) => T)(...pos);
}

export interface Statement<TRow = unknown, TParams extends unknown[] = unknown[]> {
  get(...params: TParams): TRow | null;
  all(...params: TParams): TRow[];
  run(...params: TParams): { changes: number; lastInsertRowid: number };
}

export class Database {
  private readonly raw: DatabaseSync;
  private txDepth = 0;

  constructor(filename: string, _opts?: { create?: boolean }) {
    this.raw = new DatabaseSync(filename);
  }

  exec(sql: string): void {
    this.raw.exec(sql);
  }

  query<TRow = Record<string, unknown>, TParams extends unknown[] = unknown[]>(sql: string): Statement<TRow, TParams> {
    const stmt = this.raw.prepare(sql);
    return {
      get: (...params: TParams): TRow | null => {
        const res = invokeStmt<TRow | undefined>(stmt, 'get', params);
        return res === undefined ? null : res;
      },
      all: (...params: TParams): TRow[] => invokeStmt<TRow[]>(stmt, 'all', params),
      run: (...params: TParams) => {
        const res = invokeStmt<{ changes: number | bigint; lastInsertRowid: number | bigint }>(stmt, 'run', params);
        return {
          changes: Number(res.changes),
          lastInsertRowid: Number(res.lastInsertRowid),
        };
      },
    };
  }

  transaction<T>(fn: () => T): () => T {
    return () => {
      const depth = this.txDepth;
      const sp = `_duet_sp_${depth}`;
      if (depth === 0) this.raw.exec('BEGIN');
      else this.raw.exec(`SAVEPOINT ${sp}`);
      this.txDepth++;
      try {
        const result = fn();
        this.txDepth--;
        if (depth === 0) this.raw.exec('COMMIT');
        else this.raw.exec(`RELEASE SAVEPOINT ${sp}`);
        return result;
      } catch (err) {
        this.txDepth--;
        try {
          if (depth === 0) {
            this.raw.exec('ROLLBACK');
          } else {
            this.raw.exec(`ROLLBACK TO SAVEPOINT ${sp}`);
            this.raw.exec(`RELEASE SAVEPOINT ${sp}`);
          }
        } catch {}
        throw err;
      }
    };
  }

  close(): void {
    this.raw.close();
  }
}
