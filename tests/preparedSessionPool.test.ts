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

test("claimPreparedSession does not itself trigger replenishment (deferred to scheduleReplenishmentAfterSuccess)", async () => {
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

  // A successful claim must not race the real prompt it's about to serve
  // with a concurrent session/new + warmup session/prompt call on the same
  // backend connection. Give any fire-and-forget background work a chance
  // to run before asserting nothing was created.
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(created, ["prepared-1"]);
});

test("a deferred post-claim replenishment and a concurrent reconnect health check never overshoot poolSize", async () => {
  const created: string[] = [];
  let releaseCreate: (() => void) | undefined;
  let pauseNextCreate = false;

  const pool = new PreparedSessionPool({
    enabled: true,
    poolSize: 1,
    maxAgeMs: 0,
    backgroundRetryMs: 1,
    createPreparedSession: async () => {
      const sessionId = `prepared-${created.length + 1}`;
      created.push(sessionId);
      if (pauseNextCreate) {
        // Pause here so a second, concurrent replenishment trigger has a
        // chance to race this one before it finishes creating the session.
        await new Promise<void>((resolve) => {
          releaseCreate = resolve;
        });
      }
      return sessionId;
    },
    onEvent: () => undefined,
    validateSession: async () => true
  });

  await pool.initialize();
  assert.deepEqual(created, ["prepared-1"]);

  pauseNextCreate = true;
  const claimed = await pool.claimPreparedSession();
  assert.equal(claimed, "prepared-1");

  // claimPreparedSession() itself must NOT kick off a background refill -
  // that would race the real prompt the claimed session is about to serve.
  // The caller triggers the deferred refill only after the reply is sent,
  // via scheduleReplenishmentAfterSuccess(). Start that now (creating
  // prepared-2, paused inside createPreparedSession) and, while it is still
  // in flight, trigger a second refill path (reconnect health check)
  // concurrently - before the fix, this could start a second, overlapping
  // create-loop and produce two sessions for a pool sized for one.
  const deferredReplenishPromise = pool.scheduleReplenishmentAfterSuccess();
  const reconnectPromise = pool.onReconnect();

  // Let the paused createPreparedSession call complete.
  releaseCreate?.();
  await Promise.all([deferredReplenishPromise, reconnectPromise]);

  // Only one replacement session should have been created, not two.
  assert.deepEqual(created, ["prepared-1", "prepared-2"]);
  assert.equal(await pool.claimPreparedSession(), "prepared-2");
  assert.equal(await pool.claimPreparedSession(), undefined);
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
  const events: Array<{ event: string; details?: Record<string, unknown> }> = [];

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
    validateSession: async (sessionId) => {
      validated.push(sessionId);
      return true;
    }
  });

  await pool.initialize();
  assert.deepEqual(created, ["prepared-1"]);

  await pool.onReconnect();

  // The backend still recognizes prepared-1, so no new session should have
  // been created - just validated, kept, and logged as resumed.
  assert.deepEqual(created, ["prepared-1"]);
  assert.deepEqual(validated, ["prepared-1"]);
  assert.ok(events.some(({ event, details }) => event === "resumed" && details?.sessionId === "prepared-1"));
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
  await (pool as any).runHealthCheck("watchdog");

  assert.deepEqual(created, ["prepared-1", "prepared-2"]);
  assert.ok(events.some(({ event }) => event === "invalidated"));
  assert.equal(await pool.claimPreparedSession(), "prepared-2");
});

test("a routine watchdog tick that finds the session still fine logs nothing (no 'resumed' noise)", async () => {
  const created: string[] = [];
  const events: Array<{ event: string; details?: Record<string, unknown> }> = [];

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
    validateSession: async () => true
  });

  await pool.initialize();
  events.length = 0;

  await (pool as any).runHealthCheck("watchdog");

  // Nothing changed and nothing needed resuming, so the routine watchdog
  // tick should stay silent - no "resumed", "invalidated", or "created" noise.
  assert.deepEqual(events, []);
  assert.equal(await pool.claimPreparedSession(), "prepared-1");
});

