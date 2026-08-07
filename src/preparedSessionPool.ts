type PreparedSessionPoolEvent =
  | "created"
  | "claimed"
  | "expired"
  | "failed"
  | "replenished"
  | "fallback"
  | "restored"
  | "discarded";

type PreparedSessionPoolOptions = {
  enabled: boolean;
  poolSize: number;
  maxAgeMs: number;
  backgroundRetryMs: number;
  createPreparedSession: () => Promise<string>;
  onEvent: (event: PreparedSessionPoolEvent, details?: Record<string, unknown>) => void;
  /**
   * Optional check used to determine whether a candidate session id (either
   * still held in memory across a same-process reconnect, or loaded from
   * disk after a full restart) is still recognized by the backend. When
   * provided, candidates that validate are reused directly with no new
   * warmup prompt; candidates that fail validation are discarded and
   * replaced through the normal create+warmup path.
   */
  validateSession?: (sessionId: string) => Promise<boolean>;
  /**
   * Optional hook fired whenever the pool's contents change, so callers can
   * persist the current pool to disk.
   */
  onPoolChanged?: (entries: PreparedSessionEntry[]) => void;
  /**
   * Optional hook fired for each candidate that passes validation and is
   * restored into the pool, so callers can register the id the same way
   * they would for a freshly created prepared session.
   */
  onSessionRestored?: (sessionId: string) => void;
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
    restored: 0,
    discarded: 0
  };
  private initialized = false;

  constructor(options: PreparedSessionPoolOptions) {
    this.options = options;
  }

  /**
   * Initialize the pool. If candidate entries are supplied (e.g. loaded from
   * disk after a process restart), each is validated against the backend
   * first and reused without a new warmup prompt when still recognized.
   * Any shortfall is topped up through the normal create+warmup path.
   */
  async initialize(candidates: PreparedSessionEntry[] = []): Promise<void> {
    if (!this.options.enabled || this.initialized) {
      return;
    }

    this.initialized = true;
    await this.seedFromCandidates(candidates);
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

    this.notifyPoolChanged();
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
    this.pool.splice(0, this.pool.length);
    this.notifyPoolChanged();
    this.initialized = false;
  }

  /**
   * Called after a WebSocket reconnect (same-process transport blip or a
   * fresh handshake following a full restart). Rather than discarding the
   * currently-known prepared sessions outright, each is re-validated against
   * the backend and reused (no re-warming) when still recognized. Only
   * candidates the backend no longer recognizes are replaced.
   */
  async onReconnect(): Promise<void> {
    const candidates = [...this.pool];
    this.pool.splice(0, this.pool.length);
    this.initialized = false;
    await this.initialize(candidates);
  }

  /**
   * Current pool contents (shallow copy), for callers that need to persist
   * or inspect the underlying entries rather than just the snapshot counts.
   */
  getEntries(): PreparedSessionEntry[] {
    return [...this.pool];
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

  /**
   * Validate candidate sessions (in-memory pre-reconnect entries, or entries
   * loaded from disk) against the backend and keep the ones still
   * recognized, without running the warmup prompt again. Any shortfall
   * against poolSize is then topped up via the normal create+warmup path.
   */
  private async seedFromCandidates(candidates: PreparedSessionEntry[]): Promise<void> {
    if (!this.options.enabled || !this.initialized) {
      return;
    }

    const limited = candidates.slice(0, this.options.poolSize);
    for (const candidate of limited) {
      const isValid = this.options.validateSession
        ? await this.options.validateSession(candidate.sessionId).catch(() => false)
        : false;

      if (isValid) {
        this.pool.push(candidate);
        this.counters.restored += 1;
        this.options.onSessionRestored?.(candidate.sessionId);
        this.options.onEvent("restored", {
          sessionId: candidate.sessionId,
          ageMs: Date.now() - candidate.createdAt,
          poolSize: this.pool.length
        });
        this.notifyPoolChanged();
      } else {
        this.counters.discarded += 1;
        this.options.onEvent("discarded", { sessionId: candidate.sessionId });
      }
    }

    await this.replenishToTarget();
  }

  private notifyPoolChanged(): void {
    this.options.onPoolChanged?.([...this.pool]);
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
        this.notifyPoolChanged();
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
      this.notifyPoolChanged();
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
