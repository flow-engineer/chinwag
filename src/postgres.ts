// Parley's state in Postgres, over a connection pool the app already has (node-postgres's Pool, or
// anything shaped like it). Parley takes no Postgres dependency: the app brings the client.
//
//   import pg from "pg";
//   const database = postgres(new pg.Pool({ connectionString: process.env.DATABASE_URL }));

import type { Database, Row } from "./db.ts";

interface Queryable {
  query(text: string, params?: unknown[]): Promise<{ rows: Row[]; rowCount: number | null }>;
}

/** A connection pool: queries on any connection, and one connection checked out for a transaction. */
export interface PostgresPool extends Queryable {
  connect(): Promise<Queryable & { release(error?: Error | boolean): void }>;
}

/**
 * Postgres behind Parley's Database. SQL written with `?` reaches Postgres as `$1`, `$2`, ...; a
 * transaction runs BEGIN ... COMMIT on one connection taken from the pool for it, and a connection
 * whose ROLLBACK failed is given back broken, so the pool closes it instead of reusing it.
 */
export function postgres(pool: PostgresPool): Database {
  const on = (client: Queryable): Omit<Database, "transaction"> => ({
    durable: true,
    dialect: "postgres",
    query: async (sql, params = []) => (await client.query(numbered(sql), params)).rows,
    run: async (sql, params = []) => (await client.query(numbered(sql), params)).rowCount ?? 0,
  });
  return {
    ...on(pool),
    async transaction(work) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const result = await work(on(client));
        await client.query("COMMIT");
        client.release();
        return result;
      } catch (error) {
        try {
          await client.query("ROLLBACK");
          client.release();
        } catch (rollback) {
          client.release(rollback as Error);
        }
        throw error;
      }
    },
  };
}

/** `?` placeholders as Postgres's `$n`, leaving any inside quoted strings or names alone. */
function numbered(sql: string): string {
  let n = 0;
  let quote: string | null = null;
  let out = "";
  for (const ch of sql) {
    if (quote) {
      if (ch === quote) quote = null;
    } else if (ch === "'" || ch === '"') {
      quote = ch;
    } else if (ch === "?") {
      out += `$${++n}`;
      continue;
    }
    out += ch;
  }
  return out;
}
