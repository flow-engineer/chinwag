// The database under Parley's state. Parley talks to it through this small interface, so any
// engine can sit behind it: SQLite is built in (Node's own node:sqlite), and a Postgres adapter
// wraps a client the app already has. SQL is written once with `?` placeholders; an adapter turns
// them into its own.

import { DatabaseSync } from "node:sqlite";

export type Row = Record<string, unknown>;

export interface Database {
  /** The database survives a restart (a file, or a server); in-memory SQLite does not. */
  readonly durable: boolean;
  /** Rows of a SELECT, or [] for a statement that returns none. */
  query(sql: string, params?: unknown[]): Promise<Row[]>;
  /** A statement that changes rows; resolves to how many it changed. */
  run(sql: string, params?: unknown[]): Promise<number>;
  /** Everything inside commits together or not at all. */
  transaction<T>(work: (db: Omit<Database, "transaction">) => Promise<T>): Promise<T>;
}

/**
 * SQLite in a file (one process may use it at a time) or, by default, in memory. Statements run
 * one at a time per connection: a transaction holds the connection until it ends.
 */
export function sqlite(path = ":memory:"): Database {
  const db = new DatabaseSync(path);
  if (path !== ":memory:") db.exec("PRAGMA journal_mode = WAL");
  let lock: Promise<unknown> = Promise.resolve();
  const exclusive = <T>(work: () => Promise<T>): Promise<T> => {
    const next = lock.then(work, work);
    lock = next.catch(() => undefined);
    return next;
  };
  const inner = {
    durable: path !== ":memory:",
    query: async (sql: string, params: unknown[] = []) => db.prepare(sql).all(...(params as never[])) as Row[],
    run: async (sql: string, params: unknown[] = []) => Number(db.prepare(sql).run(...(params as never[])).changes),
  };
  return {
    durable: inner.durable,
    query: (sql, params) => exclusive(() => inner.query(sql, params)),
    run: (sql, params) => exclusive(() => inner.run(sql, params)),
    transaction: (work) =>
      exclusive(async () => {
        await begin(db);
        try {
          const result = await work(inner);
          db.exec("COMMIT");
          return result;
        } catch (error) {
          db.exec("ROLLBACK");
          throw error;
        }
      }),
  };
}

/** BEGIN IMMEDIATE, waiting while another connection to the same file holds it. */
async function begin(db: DatabaseSync): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      db.exec("BEGIN IMMEDIATE");
      return;
    } catch (error) {
      const busy = (error as { errcode?: number }).errcode === 5;
      if (!busy || attempt > 200) throw error;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
}
