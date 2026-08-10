type PreparedSessionPoolEvent =
  | "created"
  | "claimed"
  | "expired"
  | "failed"
  | "replenished"
  | "fallback"
  | "invalidated";

type PreparedSessionPoolOptions = {
  enabled: boolean;
  poolSize: number;
  maxAgeMs: number;
  backgroundRetryMs: number;
  createPreparedSession: () => Promise<string>;
  onEvent: (event: PreparedSessionPoolEvent, details?: Record<string, unknown>) => void;
  /**
   * Optional check used to determine whether a pooled session id is still
   * recognized by the backend (e.g. via session/resume). Used both by the
   * periodic in-memory watchdog and by the reconnect handler, so a session
   * silently killed by the backend - or lost across a transport reconnect -
   * is detected and replaced without waiting for a real chat request to
   * discover it the hard way. Entirely in-memory: nothing is persisted to
   * disk, so a full process restart simply starts a fresh pool.
   */
  validateSession?: (sessionId: string) => Promise<boolean>;
  /**
   * Interval for the background watchdog health check. 0/undefined disables
   * the watchdog (validation still runs on reconnect regardless).
   */
  watchdogIntervalMs?: number;
};

type PreparedSessionPoolSnapshot = {
  enabled: boolean;
  initialized: boolean;
  poolSize: number;
  preparedSessionCount: number;
  inFlightCount: number;
  counters: Record<PreparedSessionPoolEvent, number>;
};

type PreparedSessionEntry = {
  sessionId: string;
  createdAt: number;
};

export class PreparedSessionPool {
  private readonly options: PreparedSessionPoolOptions;
  private readonly pool: PreparedSessionEntry[] = [];
  private readonly inFlight = new Set<Promise<void>>();
  private readonly counters: Record<PreparedSessionPoolEvent, number> = {
    created: 0,
    claimed: 0,
    expired: 0,
    failed: 0,
    replenished: 0,
    fallback: 0,
    invalidated: 0
  };
  private initialized = false;
  private watchdogTimer?: NodeJS.Timeout;

  constructor(options: PreparedSessionPoolOptions) {
    this.options = options;
  }

  async initialize(): Promise<void> {
    if (!this.options.enabled || this.initialized) {
      return;
    }

    this.initialized = true;
    await this.replenishToTarget();
    this.startWatchdog();
  }

  async claimPreparedSession(): Promise<string | undefined> {
    if (!this.options.enabled) {
      return undefined;
    }

    const now = Date.now();
    this.evictExpiredSessions(now);

    if (this.pool.length === 0) {
      this.counters.fallback += 1;
      this.options.onEvent("fallback", { poolSize: this.pool.length, maxAgeMs: this.options.maxAgeMs });
      this.startReplenishmentTask();
      return undefined;
    }

    const entry = this.pool.shift();
    if (!entry) {
      this.counters.fallback += 1;
      this.options.onEvent("fallback", { poolSize: this.pool.length, maxAgeMs: this.options.maxAgeMs });
      this.startReplenishmentTask();
      return undefined;
    }

    this.counters.claimed += 1;
    this.options.onEvent("claimed", {
      sessionId: entry.sessionId,
      ageMs: Date.now() - entry.createdAt,
      remainingPoolSize: this.pool.length
    });

    this.startReplenishmentTask();

    return entry.sessionId;
  }

  async scheduleReplenishmentAfterSuccess(): Promise<void> {
    if (!this.options.enabled || !this.initialized) {
      return;
    }

    const task = this.startReplenishmentTask();
    if (task) {
      await task;
    }
  }

  async reset(): Promise<void> {
    this.stopWatchdog();
    this.pool.splice(0, this.pool.length);
    this.initialized = false;
  }

  /**
   * Called after a WebSocket reconnect (same-process transport blip, or a
   * fresh handshake following a full restart). Rather than discarding
   * whatever the pool currently holds, each entry is re-validated against
   * the backend (session/resume) and kept when still recognized; only
   * entries the backend no longer recognizes are replaced. Purely in-memory.
   */
  async onReconnect(): Promise<void> {
    if (!this.initialized) {
      await this.initialize();
      return;
    }

    await this.runHealthCheck();
  }

  /**
   * Validate every currently pooled session against the backend and evict
   * any the backend no longer recognizes, then top the pool back up to
   * target size. Used by both the periodic watchdog and reconnect handling.
   */
  private async runHealthCheck(): Promise<void> {
    if (!this.options.enabled || !this.options.validateSession) {
      return;
    }

    const candidates = [...this.pool];
    const survivors: PreparedSessionEntry[] = [];

    for (const candidate of candidates) {
      const isValid = await this.options.validateSession(candidate.sessionId).catch(() => false);
      if (isValid) {
        survivors.push(candidate);
      } else {
        this.counters.invalidated += 1;
        this.options.onEvent("invalidated", {
          sessionId: candidate.sessionId,
          ageMs: Date.now() - candidate.createdAt
        });
      }
    }

    if (survivors.length !== this.pool.length) {
      this.pool.splice(0, this.pool.length, ...survivors);
    }

    await this.replenishToTarget();
  }

  private startWatchdog(): void {
    if (this.watchdogTimer || !this.options.validateSession) {
      return;
    }

    const intervalMs = this.options.watchdogIntervalMs ?? 0;
    if (intervalMs <= 0) {
      return;
    }

    const timer = setInterval(() => {
      void this.runHealthCheck();
    }, intervalMs);
    timer.unref?.();
    this.watchdogTimer = timer;
  }

  private stopWatchdog(): void {
    if (this.watchdogTimer) {
      clearInterval(this.watchdogTimer);
      this.watchdogTimer = undefined;
    }
  }

  getSnapshot(): PreparedSessionPoolSnapshot {
    return {
      enabled: this.options.enabled,
      initialized: this.initialized,
      poolSize: this.options.poolSize,
      preparedSessionCount: this.pool.length,
      inFlightCount: this.inFlight.size,
      counters: { ...this.counters }
    };
  }

  private async replenishToTarget(): Promise<void> {
    if (!this.options.enabled || !this.initialized) {
      return;
    }

    this.evictExpiredSessions(Date.now());

    while (this.pool.length < this.options.poolSize) {
      try {
        const sessionId = await this.options.createPreparedSession();
        const createdAt = Date.now();
        this.pool.push({ sessionId, createdAt });
        this.counters.created += 1;
        this.counters.replenished += 1;
        this.options.onEvent("created", { sessionId, createdAt, poolSize: this.pool.length });
        this.options.onEvent("replenished", { sessionId, createdAt, poolSize: this.pool.length });
      } catch (error) {
        this.counters.failed += 1;
        this.options.onEvent("failed", { error: error instanceof Error ? error.message : String(error) });
        await new Promise((resolve) => setTimeout(resolve, this.options.backgroundRetryMs));
      }
    }
  }

  private evictExpiredSessions(now: number): void {
    if (this.options.maxAgeMs <= 0) {
      return;
    }

    const active: PreparedSessionEntry[] = [];
    for (const entry of this.pool) {
      const ageMs = now - entry.createdAt;
      if (ageMs <= this.options.maxAgeMs) {
        active.push(entry);
        continue;
      }

      this.counters.expired += 1;
      this.options.onEvent("expired", {
        sessionId: entry.sessionId,
        ageMs,
        maxAgeMs: this.options.maxAgeMs
      });
    }

    if (active.length !== this.pool.length) {
      this.pool.splice(0, this.pool.length, ...active);
    }
  }

  private startReplenishmentTask(): Promise<void> | undefined {
    if (!this.options.enabled || !this.initialized) {
      return undefined;
    }

    if (this.inFlight.size > 0) {
      return undefined;
    }

    const task = this.replenishToTarget().catch((error) => {
      this.counters.failed += 1;
      this.options.onEvent("failed", { error: error instanceof Error ? error.message : String(error) });
    });

    this.inFlight.add(task);
    void task.finally(() => {
      this.inFlight.delete(task);
    });

    return task;
  }
}
