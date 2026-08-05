type PreparedSessionPoolEvent =
  | "created"
  | "claimed"
  | "expired"
  | "failed"
  | "replenished"
  | "fallback";

type PreparedSessionPoolOptions = {
  enabled: boolean;
  poolSize: number;
  maxAgeMs: number;
  backgroundRetryMs: number;
  createPreparedSession: () => Promise<string>;
  onEvent: (event: PreparedSessionPoolEvent, details?: Record<string, unknown>) => void;
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
    fallback: 0
  };
  private initialized = false;

  constructor(options: PreparedSessionPoolOptions) {
    this.options = options;
  }

  async initialize(): Promise<void> {
    if (!this.options.enabled || this.initialized) {
      return;
    }

    this.initialized = true;
    await this.replenishToTarget();
  }

  async claimPreparedSession(): Promise<string | undefined> {
    if (!this.options.enabled) {
      return undefined;
    }

    const now = Date.now();
    const activeIndex = this.pool.findIndex((entry) => now - entry.createdAt <= this.options.maxAgeMs);
    if (activeIndex < 0) {
      this.counters.fallback += 1;
      this.options.onEvent("fallback", { poolSize: this.pool.length, maxAgeMs: this.options.maxAgeMs });
      return undefined;
    }

    const [entry] = this.pool.splice(activeIndex, 1);
    this.counters.claimed += 1;
    this.options.onEvent("claimed", {
      sessionId: entry.sessionId,
      ageMs: Date.now() - entry.createdAt,
      remainingPoolSize: this.pool.length
    });

    return entry.sessionId;
  }

  async reset(): Promise<void> {
    this.pool.splice(0, this.pool.length);
    this.initialized = false;
  }

  async onReconnect(): Promise<void> {
    await this.reset();
    await this.initialize();
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

  private async replenishInBackground(): Promise<void> {
    if (!this.options.enabled || !this.initialized) {
      return;
    }

    const task = this.replenishToTarget().catch((error) => {
      this.options.onEvent("failed", { error: error instanceof Error ? error.message : String(error) });
    });

    this.inFlight.add(task);
    await task;
    this.inFlight.delete(task);
  }

  private async replenishToTarget(): Promise<void> {
    if (!this.options.enabled || !this.initialized) {
      return;
    }

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
}
