/**
 * Session record tracking conversation state with backend
 */
export type SessionRecord = {
  // Bot conversation identity (combination of channelId|conversationId|userId)
  conversationKey: string;
  
  // Backend session ID (assigned by backend on session/new or session/load)
  sessionId?: string;
  
  // Session state: new (not yet initialized), ready (initialized and authenticated)
  sessionState: "new" | "initializing" | "ready" | "error";
  
  // Session mode: "new" (created this conversation), "resumed" (previous session), "loaded" (from persistent store)
  sessionMode?: "new" | "resumed" | "loaded";
  
  // Backend agent capabilities (populated after initialize response)
  capabilities?: {
    authMethods?: string[];
    loadSession?: boolean;
    persistSession?: boolean;
  };
  
  // Timestamps
  createdAt: number;
  initializedAt?: number;
  lastSeenAt: number;
  
  // Error tracking
  lastError?: {
    message: string;
    code?: string;
    timestamp: number;
  };
};

function createEffectiveId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export class SessionStore {
  private readonly store = new Map<string, SessionRecord>();

  /**
   * Get or create a session record for a conversation
   */
  public getOrCreate(conversationKey: string): SessionRecord {
    const existing = this.store.get(conversationKey);
    if (existing) {
      existing.lastSeenAt = Date.now();
      return existing;
    }

    const now = Date.now();
    const created: SessionRecord = {
      conversationKey,
      sessionState: "new",
      createdAt: now,
      lastSeenAt: now
    };

    this.store.set(conversationKey, created);
    return created;
  }

  /**
   * Get existing session (doesn't create)
   */
  public get(conversationKey: string): SessionRecord | undefined {
    return this.store.get(conversationKey);
  }

  /**
   * Refresh activity timestamp for a conversation session.
   */
  public touch(conversationKey: string): void {
    const session = this.store.get(conversationKey);
    if (session) {
      session.lastSeenAt = Date.now();
    }
  }

  /**
   * Check whether a session is expired based on inactivity TTL.
   */
  public isExpired(conversationKey: string, ttlMs: number): boolean {
    const session = this.store.get(conversationKey);
    if (!session) {
      return false;
    }

    return (Date.now() - session.lastSeenAt) > ttlMs;
  }

  /**
   * Update session with backend sessionId after initialization
   */
  public setSessionId(conversationKey: string, sessionId: string, mode: "new" | "resumed" | "loaded" = "new"): void {
    const session = this.store.get(conversationKey);
    if (session) {
      session.sessionId = sessionId;
      session.sessionMode = mode;
      session.sessionState = "ready";
      session.initializedAt = Date.now();
    }
  }

  /**
   * Update session capabilities after initialize response
   */
  public setCapabilities(conversationKey: string, capabilities: SessionRecord["capabilities"]): void {
    const session = this.store.get(conversationKey);
    if (session) {
      session.capabilities = capabilities;
    }
  }

  /**
   * Mark session as error state
   */
  public setError(conversationKey: string, message: string, code?: string): void {
    const session = this.store.get(conversationKey);
    if (session) {
      session.sessionState = "error";
      session.lastError = {
        message,
        code,
        timestamp: Date.now()
      };
    }
  }

  /**
   * Mark session back to ready after error recovery
   */
  public clearError(conversationKey: string): void {
    const session = this.store.get(conversationKey);
    if (session) {
      session.sessionState = "ready";
      session.lastError = undefined;
    }
  }

  /**
   * Reset session state so caller can recreate backend session after failures
   */
  public resetToNew(conversationKey: string): void {
    const session = this.store.get(conversationKey);
    if (session) {
      session.sessionId = undefined;
      session.sessionMode = undefined;
      session.sessionState = "new";
      session.initializedAt = undefined;
      session.lastError = undefined;
      session.lastSeenAt = Date.now();
    }
  }

  /**
   * Reset all sessions to "new" state (e.g. after backend reconnect)
   */
  public resetAll(): void {
    for (const key of this.store.keys()) {
      this.resetToNew(key);
    }
  }

  /**
   * Get session size
   */
  public size(): number {
    return this.store.size;
  }

  /**
   * Clean up old sessions (older than ttlMs, default 24 hours)
   */
  public cleanup(ttlMs: number = 24 * 60 * 60 * 1000): number {
    const now = Date.now();
    let removed = 0;

    for (const [key, session] of this.store.entries()) {
      if (now - session.lastSeenAt > ttlMs) {
        this.store.delete(key);
        removed++;
      }
    }

    return removed;
  }
}
