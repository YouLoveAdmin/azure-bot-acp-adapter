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

  await pool.scheduleReplenishmentAfterSuccess();
  assert.equal(await pool.claimPreparedSession(), "prepared-2");
});

test("PreparedSessionPool evicts expired sessions before fallback and replenishes", async () => {
  const created: string[] = [];
  const events: Array<{ event: string; details?: Record<string, unknown> }> = [];
  const originalNow = Date.now;
  let now = 1_000;

  Date.now = () => now;

  try {
    const pool = new PreparedSessionPool({
      enabled: true,
      poolSize: 1,
      maxAgeMs: 10,
      backgroundRetryMs: 1,
      createPreparedSession: async () => {
        const sessionId = `prepared-${created.length + 1}`;
        created.push(sessionId);
        return sessionId;
      },
      onEvent: (event, details) => {
        events.push({ event, details });
      }
    });

    await pool.initialize();
    assert.equal(created[0], "prepared-1");

    now = 2_000;

    const fallback = await pool.claimPreparedSession();
    assert.equal(fallback, undefined);

    await pool.scheduleReplenishmentAfterSuccess();

    assert.equal(created[1], "prepared-2");
    assert.ok(events.some(({ event }) => event === "expired"));
    assert.ok(events.some(({ event }) => event === "fallback"));
  } finally {
    Date.now = originalNow;
  }
});

test("PreparedSessionPool does not expire sessions when maxAgeMs is zero", async () => {
  const created: string[] = [];
  const events: Array<{ event: string; details?: Record<string, unknown> }> = [];
  const originalNow = Date.now;
  let now = 1_000;

  Date.now = () => now;

  try {
    const pool = new PreparedSessionPool({
      enabled: true,
      poolSize: 1,
      maxAgeMs: 0,
      backgroundRetryMs: 1,
      createPreparedSession: async () => {
        const sessionId = `prepared-${created.length + 1}`;
        created.push(sessionId);
        return sessionId;
      },
      onEvent: (event, details) => {
        events.push({ event, details });
      }
    });

    await pool.initialize();
    assert.equal(created[0], "prepared-1");

    now = 86_400_000;

    const claimed = await pool.claimPreparedSession();
    assert.equal(claimed, "prepared-1");
    assert.ok(!events.some(({ event }) => event === "expired"));
  } finally {
    Date.now = originalNow;
  }
});

test("onReconnect reuses a pooled session that the backend still recognizes (no re-warming)", async () => {
  const created: string[] = [];
  const validated: string[] = [];

  const pool = new PreparedSessionPool({
    enabled: true,
    poolSize: 1,
    maxAgeMs: 0,
    backgroundRetryMs: 1,
    createPreparedSession: async () => {
      const sessionId = `prepared-${created.length + 1}`;
      created.push(sessionId);
      return sessionId;
    },
    onEvent: () => undefined,
    validateSession: async (sessionId) => {
      validated.push(sessionId);
      return true;
    }
  });

  await pool.initialize();
  assert.deepEqual(created, ["prepared-1"]);

  await pool.onReconnect();

  // The backend still recognizes prepared-1, so no new session should have
  // been created - just validated and kept.
  assert.deepEqual(created, ["prepared-1"]);
  assert.deepEqual(validated, ["prepared-1"]);
  assert.equal(await pool.claimPreparedSession(), "prepared-1");
});

test("onReconnect discards and replaces a pooled session the backend no longer recognizes", async () => {
  const created: string[] = [];

  const pool = new PreparedSessionPool({
    enabled: true,
    poolSize: 1,
    maxAgeMs: 0,
    backgroundRetryMs: 1,
    createPreparedSession: async () => {
      const sessionId = `prepared-${created.length + 1}`;
      created.push(sessionId);
      return sessionId;
    },
    onEvent: () => undefined,
    validateSession: async () => false
  });

  await pool.initialize();
  assert.deepEqual(created, ["prepared-1"]);

  await pool.onReconnect();

  assert.deepEqual(created, ["prepared-1", "prepared-2"]);
  assert.equal(await pool.claimPreparedSession(), "prepared-2");
});

test("background watchdog periodically invalidates and replaces a killed session without any claim", async () => {
  const created: string[] = [];
  const events: Array<{ event: string; details?: Record<string, unknown> }> = [];
  let backendKilledFirstSession = false;

  const pool = new PreparedSessionPool({
    enabled: true,
    poolSize: 1,
    maxAgeMs: 0,
    backgroundRetryMs: 1,
    createPreparedSession: async () => {
      const sessionId = `prepared-${created.length + 1}`;
      created.push(sessionId);
      return sessionId;
    },
    onEvent: (event, details) => {
      events.push({ event, details });
    },
    validateSession: async () => !backendKilledFirstSession
  });

  await pool.initialize();
  assert.deepEqual(created, ["prepared-1"]);

  // Simulate the backend silently killing the pooled session with no
  // WebSocket reconnect involved at all.
  backendKilledFirstSession = true;

  // Directly invoke the watchdog's health check (same method the periodic
  // timer calls) rather than waiting on a real interval.
  await (pool as any).runHealthCheck();

  assert.deepEqual(created, ["prepared-1", "prepared-2"]);
  assert.ok(events.some(({ event }) => event === "invalidated"));
  assert.equal(await pool.claimPreparedSession(), "prepared-2");
});

