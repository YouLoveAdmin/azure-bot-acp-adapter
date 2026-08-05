import test from "node:test";
import assert from "node:assert/strict";
import { WebSocketSessionCoordinator } from "../src/websocketSessionCoordinator";
import { SessionStore } from "../src/sessionStore";

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

test("ensureSession creates a fresh session when prepared-session resume fails", async () => {
  const coordinator = new WebSocketSessionCoordinator(new SessionStore());
  const calls: string[] = [];

  const manager = {
    sessionResume: async () => {
      calls.push("resume");
      throw new Error('[-32601] "Method not found": session/resume');
    },
    sessionLoad: async () => {
      calls.push("load");
      throw new Error("Method not found");
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

  assert.equal(sessionId, "fresh-session");
  assert.deepEqual(calls, ["resume", "load", "new"]);
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
