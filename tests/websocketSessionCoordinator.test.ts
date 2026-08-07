import test from "node:test";
import assert from "node:assert/strict";
import { WebSocketSessionCoordinator } from "../src/websocketSessionCoordinator";
import { SessionStore } from "../src/sessionStore";
import { config } from "../src/config";
import { savePersistedPreparedSessions, loadPersistedPreparedSessions } from "../src/preparedSessionPersistence";

/**
 * Prepared-session pool replenishment can run as a fire-and-forget background
 * task (not awaited by the caller that triggered it). Since these tests share
 * the real persisted-pool file on disk, wait for any such in-flight task to
 * finish before moving on so its write doesn't leak into a later test.
 */
async function waitForPoolIdle(coordinator: WebSocketSessionCoordinator): Promise<void> {
  const pool = (coordinator as any).preparedSessionPool;
  for (let attempt = 0; attempt < 50; attempt++) {
    if (pool.getSnapshot().inFlightCount === 0) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("resumeSessionWithFallback uses session/load when session/resume is unsupported", async () => {
  const coordinator = new WebSocketSessionCoordinator(new SessionStore());
  const calls: string[] = [];

  const manager = {
    sessionResume: async () => {
      calls.push("resume");
      throw new Error('[-32601] "Method not found": session/resume');
    },
    sessionLoad: async (sessionId: string) => {
      calls.push(`load:${sessionId}`);
      return { sessionId };
    },
    sessionNew: async () => ({ sessionId: "fresh-session" }),
    setConfigOption: async () => undefined,
    sessionPrompt: async () => ({ stopReason: "completion" as const }),
    sessionDestroy: async () => undefined
  };

  (coordinator as any).manager = manager;
  (coordinator as any).isInitialized = true;

  const resumedSessionId = await coordinator.resumeSession("conv-1", "existing-session");

  assert.equal(resumedSessionId, "existing-session");
  assert.deepEqual(calls, ["resume", "load:existing-session"]);
});

test("ensureSession binds the claimed prepared session directly without calling resume or load", async () => {
  const coordinator = new WebSocketSessionCoordinator(new SessionStore());
  const calls: string[] = [];

  const manager = {
    sessionResume: async () => {
      calls.push("resume");
      throw new Error("should not be called");
    },
    sessionLoad: async () => {
      calls.push("load");
      throw new Error("should not be called");
    },
    sessionNew: async () => {
      calls.push("new");
      return { sessionId: "fresh-session" };
    },
    setConfigOption: async () => undefined,
    sessionPrompt: async () => ({ stopReason: "completion" as const }),
    sessionDestroy: async () => undefined
  };

  (coordinator as any).manager = manager;
  (coordinator as any).isInitialized = true;
  (coordinator as any).preparedSessionPool.claimPreparedSession = async () => "prepared-session";

  const sessionId = await coordinator.ensureSession("conv-2");

  assert.equal(sessionId, "prepared-session");
  assert.deepEqual(calls, []);
});

test("ensureSession falls back to a fresh session when the prepared pool has nothing to claim", async () => {
  const coordinator = new WebSocketSessionCoordinator(new SessionStore());
  const calls: string[] = [];

  const manager = {
    sessionResume: async () => {
      calls.push("resume");
      throw new Error("should not be called");
    },
    sessionLoad: async () => {
      calls.push("load");
      throw new Error("should not be called");
    },
    sessionNew: async () => {
      calls.push("new");
      return { sessionId: "fresh-session" };
    },
    setConfigOption: async () => undefined,
    sessionPrompt: async () => ({ stopReason: "completion" as const }),
    sessionDestroy: async () => undefined
  };

  (coordinator as any).manager = manager;
  (coordinator as any).isInitialized = true;
  (coordinator as any).preparedSessionPool.claimPreparedSession = async () => undefined;

  const sessionId = await coordinator.ensureSession("conv-empty-pool");

  assert.equal(sessionId, "fresh-session");
  assert.deepEqual(calls, ["new"]);
});

test("ensureSession does not use the prepared-session pool for an existing conversation", async () => {
  const store = new SessionStore();
  const existing = store.getOrCreate("conv-3");
  existing.sessionState = "new";
  existing.sessionMode = undefined;
  existing.sessionId = undefined;

  const coordinator = new WebSocketSessionCoordinator(store);
  const calls: string[] = [];

  const manager = {
    sessionResume: async () => {
      calls.push("resume");
      throw new Error("should not be called");
    },
    sessionLoad: async () => {
      calls.push("load");
      throw new Error("should not be called");
    },
    sessionNew: async () => {
      calls.push("new");
      return { sessionId: "fresh-session-for-existing-conversation" };
    },
    setConfigOption: async () => undefined,
    sessionPrompt: async () => ({ stopReason: "completion" as const }),
    sessionDestroy: async () => undefined
  };

  (coordinator as any).manager = manager;
  (coordinator as any).isInitialized = true;
  (coordinator as any).preparedSessionPool.claimPreparedSession = async () => {
    throw new Error("prepared pool should not be used for an existing conversation");
  };

  const sessionId = await coordinator.ensureSession("conv-3");

  assert.equal(sessionId, "fresh-session-for-existing-conversation");
  assert.deepEqual(calls, ["new"]);
});

test("createPreparedSessionInternal still returns a session when default config is unsupported", async () => {
  const coordinator = new WebSocketSessionCoordinator(new SessionStore());
  const manager = {
    sessionNew: async () => ({ sessionId: "prepared-session-without-config" }),
    setConfigOption: async () => {
      throw new Error("unsupported config");
    },
    sessionResume: async () => ({ sessionId: "unused" }),
    sessionLoad: async () => ({ sessionId: "unused" }),
    sessionPrompt: async () => ({ stopReason: "completion" as const }),
    sessionDestroy: async () => undefined
  };

  (coordinator as any).manager = manager;
  (coordinator as any).isInitialized = true;

  const sessionId = await (coordinator as any).createPreparedSessionInternal();

  assert.equal(sessionId, "prepared-session-without-config");
});

test("createPreparedSessionInternal sends warmup prompt when configured", async () => {
  const coordinator = new WebSocketSessionCoordinator(new SessionStore());
  const calls: string[] = [];
  const originalPrompt = config.warmupSessionInitialPrompt;
  (config as any).warmupSessionInitialPrompt = "warmup prompt text";

  const manager = {
    sessionNew: async () => {
      calls.push("new");
      return { sessionId: "prepared-with-warmup" };
    },
    setConfigOption: async () => undefined,
    sessionPrompt: async (sessionId: string, prompt: string) => {
      calls.push(`prompt:${sessionId}:${prompt}`);
      return { stopReason: "completion" as const };
    },
    sessionDestroy: async () => {
      calls.push("destroy");
      return undefined;
    },
    sessionResume: async () => ({ sessionId: "unused" }),
    sessionLoad: async () => ({ sessionId: "unused" })
  };

  (coordinator as any).manager = manager;
  (coordinator as any).isInitialized = true;

  try {
    const sessionId = await (coordinator as any).createPreparedSessionInternal();
    assert.equal(sessionId, "prepared-with-warmup");
    assert.deepEqual(calls, ["new", "prompt:prepared-with-warmup:warmup prompt text"]);
  } finally {
    (config as any).warmupSessionInitialPrompt = originalPrompt;
  }
});

test("createPreparedSessionInternal destroys session when warmup prompt fails", async () => {
  const coordinator = new WebSocketSessionCoordinator(new SessionStore());
  const calls: string[] = [];
  const originalPrompt = config.warmupSessionInitialPrompt;
  (config as any).warmupSessionInitialPrompt = "warmup prompt text";

  const manager = {
    isReady: () => true,
    sessionNew: async () => {
      calls.push("new");
      return { sessionId: "prepared-fail-warmup" };
    },
    setConfigOption: async () => undefined,
    sessionPrompt: async () => {
      calls.push("prompt");
      return { stopReason: "error" as const, exitCode: 23 };
    },
    sessionDestroy: async (sessionId: string) => {
      calls.push(`destroy:${sessionId}`);
      return undefined;
    },
    sessionResume: async () => ({ sessionId: "unused" }),
    sessionLoad: async () => ({ sessionId: "unused" })
  };

  (coordinator as any).manager = manager;
  (coordinator as any).isInitialized = true;

  try {
    await assert.rejects(
      async () => (coordinator as any).createPreparedSessionInternal(),
      /Prepared session warmup prompt failed \(exitCode=23\)/
    );
    assert.deepEqual(calls, ["new", "prompt", "destroy:prepared-fail-warmup"]);
  } finally {
    (config as any).warmupSessionInitialPrompt = originalPrompt;
  }
});

test("createPreparedSessionInternal skips destroy when warmup fails and websocket is disconnected", async () => {
  const coordinator = new WebSocketSessionCoordinator(new SessionStore());
  const calls: string[] = [];
  const originalPrompt = config.warmupSessionInitialPrompt;
  (config as any).warmupSessionInitialPrompt = "warmup prompt text";

  const manager = {
    isReady: () => false,
    sessionNew: async () => {
      calls.push("new");
      return { sessionId: "prepared-fail-warmup-disconnected" };
    },
    setConfigOption: async () => undefined,
    sessionPrompt: async () => {
      calls.push("prompt");
      return { stopReason: "error" as const, exitCode: 24 };
    },
    sessionDestroy: async (sessionId: string) => {
      calls.push(`destroy:${sessionId}`);
      return undefined;
    },
    sessionResume: async () => ({ sessionId: "unused" }),
    sessionLoad: async () => ({ sessionId: "unused" })
  };

  (coordinator as any).manager = manager;
  (coordinator as any).isInitialized = true;

  try {
    await assert.rejects(
      async () => (coordinator as any).createPreparedSessionInternal(),
      /Prepared session warmup prompt failed \(exitCode=24\)/
    );
    assert.deepEqual(calls, ["new", "prompt"]);
  } finally {
    (config as any).warmupSessionInitialPrompt = originalPrompt;
  }
});

test("automatic background reconnect revalidates the prepared session via resume and reuses it without re-warming", async () => {
  savePersistedPreparedSessions([]);

  const coordinator = new WebSocketSessionCoordinator(new SessionStore());
  const listeners: Record<string, (...args: any[]) => any> = {};
  let sessionCounter = 0;
  const calls: string[] = [];

  const manager = {
    initialize: async () => ({ protocolVersion: 1, authMethods: [] }),
    on: (event: string, callback: (...args: any[]) => any) => {
      listeners[event] = callback;
    },
    isReady: () => true,
    sessionNew: async () => {
      sessionCounter += 1;
      calls.push("new");
      return { sessionId: `prepared-${sessionCounter}` };
    },
    setConfigOption: async () => undefined,
    sessionPrompt: async () => {
      calls.push("prompt");
      return { stopReason: "completion" as const };
    },
    sessionDestroy: async () => undefined,
    sessionResume: async () => {
      calls.push("resume");
      return { sessionId: "unused" };
    },
    sessionLoad: async () => ({ sessionId: "unused" })
  };

  await coordinator.initialize(manager as any);

  // Pool was filled once during startup - it should hold the first prepared session.
  const preSnapshot = (coordinator as any).preparedSessionPool.getSnapshot();
  assert.equal(preSnapshot.preparedSessionCount, 1);
  calls.length = 0;

  // Simulate the WebSocketManager reconnecting entirely on its own (no incoming
  // chat request involved) - this is what happens overnight after an idle
  // transport drop and self-heal.
  await listeners["reconnected"]();

  // The backend still recognizes the pre-reconnect session (session/resume
  // succeeds), so it must be reused directly with no new session/new or
  // warmup prompt call - this is the token-saving behavior being verified.
  assert.deepEqual(calls, ["resume"]);
  const claimedAfterReconnect = await (coordinator as any).preparedSessionPool.claimPreparedSession();
  assert.equal(claimedAfterReconnect, "prepared-1");
  await waitForPoolIdle(coordinator);
  savePersistedPreparedSessions([]);
});

test("automatic background reconnect discards and re-warms a session the backend no longer recognizes", async () => {
  savePersistedPreparedSessions([]);

  const coordinator = new WebSocketSessionCoordinator(new SessionStore());
  const listeners: Record<string, (...args: any[]) => any> = {};
  let sessionCounter = 0;

  const manager = {
    initialize: async () => ({ protocolVersion: 1, authMethods: [] }),
    on: (event: string, callback: (...args: any[]) => any) => {
      listeners[event] = callback;
    },
    isReady: () => true,
    sessionNew: async () => {
      sessionCounter += 1;
      return { sessionId: `prepared-${sessionCounter}` };
    },
    setConfigOption: async () => undefined,
    sessionPrompt: async () => ({ stopReason: "completion" as const }),
    sessionDestroy: async () => undefined,
    sessionResume: async () => {
      throw new Error("Session not found");
    },
    sessionLoad: async () => ({ sessionId: "unused" })
  };

  await coordinator.initialize(manager as any);

  await listeners["reconnected"]();

  // The backend no longer recognizes prepared-1, so a brand-new session must
  // have been created and warmed to fill the pool.
  const claimedAfterReconnect = await (coordinator as any).preparedSessionPool.claimPreparedSession();
  assert.equal(claimedAfterReconnect, "prepared-2");
  await waitForPoolIdle(coordinator);
  savePersistedPreparedSessions([]);
});

test("initialize() seeds the pool from disk-persisted prepared sessions after a full process restart", async () => {
  savePersistedPreparedSessions([{ sessionId: "disk-persisted-session", createdAt: Date.now() }]);

  const coordinator = new WebSocketSessionCoordinator(new SessionStore());
  const calls: string[] = [];
  const manager = {
    initialize: async () => ({ protocolVersion: 1, authMethods: [] }),
    on: () => undefined,
    isReady: () => true,
    sessionNew: async () => {
      calls.push("new");
      return { sessionId: "unused-fresh" };
    },
    setConfigOption: async () => undefined,
    sessionPrompt: async () => ({ stopReason: "completion" as const }),
    sessionDestroy: async () => undefined,
    sessionResume: async (sessionId: string) => {
      calls.push(`resume:${sessionId}`);
      return { sessionId };
    },
    sessionLoad: async () => ({ sessionId: "unused" })
  };

  await coordinator.initialize(manager as any);

  assert.deepEqual(calls, ["resume:disk-persisted-session"]);
  const claimed = await (coordinator as any).preparedSessionPool.claimPreparedSession();
  assert.equal(claimed, "disk-persisted-session");

  await waitForPoolIdle(coordinator);
  savePersistedPreparedSessions([]);
});

test("prepared-session persistence round-trips entries to disk", () => {
  const entries = [{ sessionId: "round-trip-session", createdAt: 12345 }];
  savePersistedPreparedSessions(entries);
  const loaded = loadPersistedPreparedSessions();
  assert.deepEqual(loaded, entries);
  savePersistedPreparedSessions([]);
});
