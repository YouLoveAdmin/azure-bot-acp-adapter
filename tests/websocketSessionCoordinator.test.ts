import test from "node:test";
import assert from "node:assert/strict";
import { WebSocketSessionCoordinator } from "../src/websocketSessionCoordinator";
import { SessionStore } from "../src/sessionStore";
import { config } from "../src/config";

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
