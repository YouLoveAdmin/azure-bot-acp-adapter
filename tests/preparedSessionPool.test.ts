import test from "node:test";
import assert from "node:assert/strict";
import { PreparedSessionPool } from "../src/preparedSessionPool";

test("PreparedSessionPool claims a prepared session and removes it from the pool", async () => {
  const created: string[] = [];
  const pool = new PreparedSessionPool({
    enabled: true,
    poolSize: 1,
    maxAgeMs: 60_000,
    backgroundRetryMs: 1_000,
    createPreparedSession: async () => {
      const sessionId = `prepared-${created.length + 1}`;
      created.push(sessionId);
      return sessionId;
    },
    onEvent: () => undefined
  });

  await pool.initialize();

  assert.deepEqual(created, ["prepared-1"]);

  const claimed = await pool.claimPreparedSession();
  assert.equal(claimed, "prepared-1");
  assert.equal(await pool.claimPreparedSession(), undefined);
});
