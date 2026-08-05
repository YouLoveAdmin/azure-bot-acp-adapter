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
