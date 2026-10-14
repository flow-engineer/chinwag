// covers: src/postgres.ts
// The adapter over a recording stand-in for node-postgres's Pool: no Postgres here. Chinwag's
// queries are checked against a real Postgres outside this suite.
import assert from "node:assert/strict";
import { test } from "node:test";
import { postgres, type PostgresPool } from "../src/index.ts";

function recordingPool(fail?: string) {
  const sent: Array<{ on: string; text: string; params?: unknown[] }> = [];
  const released: unknown[] = [];
  const queryOn = (on: string) => async (text: string, params?: unknown[]) => {
    sent.push({ on, text, params });
    if (fail && text.startsWith(fail)) throw new Error(`${fail} failed`);
    return { rows: [{ id: 1 }], rowCount: 1 };
  };
  const pool: PostgresPool = {
    query: queryOn("pool"),
    connect: async () => ({ query: queryOn("tx"), release: (error?: unknown) => void released.push(error) }),
  };
  return { pool, sent, released };
}

test("SQL written with ? reaches Postgres numbered, leaving a ? inside quotes alone", async () => {
  const { pool, sent } = recordingPool();
  await postgres(pool).query("SELECT * FROM t WHERE a = ? AND b = '?' AND c = ?", [1, 2]);
  assert.deepEqual(sent, [{ on: "pool", text: "SELECT * FROM t WHERE a = $1 AND b = '?' AND c = $2", params: [1, 2] }]);
});

test("a transaction runs on one checked-out connection and rolls back when its work fails", async () => {
  const { pool, sent, released } = recordingPool("INSERT");
  await assert.rejects(postgres(pool).transaction((tx) => tx.run("INSERT INTO t VALUES (?)", [1])), /INSERT failed/);
  assert.deepEqual(sent.map((s) => `${s.on} ${s.text}`), ["tx BEGIN", "tx INSERT INTO t VALUES ($1)", "tx ROLLBACK"]);
  assert.deepEqual(released, [undefined], "given back to the pool once, healthy");
});
