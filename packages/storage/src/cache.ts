import { Redis, type Redis as RedisClient } from "ioredis";

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetAt: number;
}

export interface CacheStats {
  hits: number;
  misses: number;
  sets: number;
  deletes: number;
  rateLimitHits: number;
}

/**
 * Common cache client interface for disposable caches and distributed limits.
 * Per Section 25.2: Cache failures must not erase durable runs.
 */
export interface CacheClient {
  get<T>(key: string): Promise<T | null>;
  set<T>(key: string, value: T, ttlSeconds?: number): Promise<void>;
  delete(key: string): Promise<void>;
  checkRateLimit(key: string, limit: number, windowSeconds: number): Promise<RateLimitResult>;
  getStats(): CacheStats;
  close(): Promise<void>;
}

interface MemoryEntry {
  value: unknown;
  expiresAt: number | null;
}

interface RateLimitBucket {
  count: number;
  resetAt: number;
}

/**
 * In-memory fallback cache client.
 * Provides zero-dependency caching for local workbench development and fallback.
 */
export class MemoryCacheClient implements CacheClient {
  private readonly store = new Map<string, MemoryEntry>();
  private readonly rateLimits = new Map<string, RateLimitBucket>();
  private readonly stats: CacheStats = {
    hits: 0,
    misses: 0,
    sets: 0,
    deletes: 0,
    rateLimitHits: 0,
  };

  async get<T>(key: string): Promise<T | null> {
    const entry = this.store.get(key);
    if (!entry) {
      this.stats.misses += 1;
      return null;
    }

    if (entry.expiresAt !== null && Date.now() > entry.expiresAt) {
      this.store.delete(key);
      this.stats.misses += 1;
      return null;
    }

    this.stats.hits += 1;
    return entry.value as T;
  }

  async set<T>(key: string, value: T, ttlSeconds?: number): Promise<void> {
    const expiresAt = ttlSeconds !== undefined ? Date.now() + ttlSeconds * 1000 : null;
    this.store.set(key, { value, expiresAt });
    this.stats.sets += 1;
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
    this.stats.deletes += 1;
  }

  async checkRateLimit(key: string, limit: number, windowSeconds: number): Promise<RateLimitResult> {
    const now = Date.now();
    let bucket = this.rateLimits.get(key);

    if (!bucket || now >= bucket.resetAt) {
      bucket = {
        count: 1,
        resetAt: now + windowSeconds * 1000,
      };
      this.rateLimits.set(key, bucket);
      return {
        allowed: true,
        remaining: Math.max(0, limit - 1),
        resetAt: bucket.resetAt,
      };
    }

    if (bucket.count < limit) {
      bucket.count += 1;
      return {
        allowed: true,
        remaining: Math.max(0, limit - bucket.count),
        resetAt: bucket.resetAt,
      };
    }

    this.stats.rateLimitHits += 1;
    return {
      allowed: false,
      remaining: 0,
      resetAt: bucket.resetAt,
    };
  }

  getStats(): CacheStats {
    return { ...this.stats };
  }

  async close(): Promise<void> {
    this.store.clear();
    this.rateLimits.clear();
  }
}

/**
 * Valkey / Redis distributed cache client.
 * Connects to Valkey via ioredis with graceful degradation to an internal memory fallback.
 */
export class ValkeyCacheClient implements CacheClient {
  private readonly redis: RedisClient;
  private readonly fallback = new MemoryCacheClient();
  private isConnected = false;
  private readonly stats: CacheStats = {
    hits: 0,
    misses: 0,
    sets: 0,
    deletes: 0,
    rateLimitHits: 0,
  };

  constructor(connectionUrl: string) {
    this.redis = new Redis(connectionUrl, {
      lazyConnect: true,
      maxRetriesPerRequest: 2,
      enableOfflineQueue: false,
      retryStrategy: (times: number) => {
        if (times > 3) return null;
        return Math.min(times * 100, 1000);
      },
    });

    this.redis.on("connect", () => {
      this.isConnected = true;
    });

    this.redis.on("error", () => {
      this.isConnected = false;
    });

    this.redis.on("close", () => {
      this.isConnected = false;
    });
  }

  async connect(): Promise<void> {
    try {
      await this.redis.connect();
      this.isConnected = true;
    } catch {
      this.isConnected = false;
    }
  }

  async get<T>(key: string): Promise<T | null> {
    if (!this.isConnected) {
      return this.fallback.get<T>(key);
    }

    try {
      const raw = await this.redis.get(key);
      if (raw === null) {
        this.stats.misses += 1;
        return null;
      }
      this.stats.hits += 1;
      return JSON.parse(raw) as T;
    } catch {
      return this.fallback.get<T>(key);
    }
  }

  async set<T>(key: string, value: T, ttlSeconds?: number): Promise<void> {
    if (!this.isConnected) {
      return this.fallback.set(key, value, ttlSeconds);
    }

    try {
      const serialized = JSON.stringify(value);
      if (ttlSeconds !== undefined && ttlSeconds > 0) {
        await this.redis.set(key, serialized, "EX", ttlSeconds);
      } else {
        await this.redis.set(key, serialized);
      }
      this.stats.sets += 1;
    } catch {
      await this.fallback.set(key, value, ttlSeconds);
    }
  }

  async delete(key: string): Promise<void> {
    if (!this.isConnected) {
      return this.fallback.delete(key);
    }

    try {
      await this.redis.del(key);
      this.stats.deletes += 1;
    } catch {
      await this.fallback.delete(key);
    }
  }

  async checkRateLimit(key: string, limit: number, windowSeconds: number): Promise<RateLimitResult> {
    if (!this.isConnected) {
      return this.fallback.checkRateLimit(key, limit, windowSeconds);
    }

    // Atomic sliding window rate limiter in Lua
    const luaScript = `
      local key = KEYS[1]
      local limit = tonumber(ARGV[1])
      local window = tonumber(ARGV[2])
      local now = tonumber(ARGV[3])
      local clearBefore = now - (window * 1000)

      redis.call('ZREMRANGEBYSCORE', key, 0, clearBefore)
      local currentRequests = redis.call('ZCARD', key)

      if currentRequests < limit then
        redis.call('ZADD', key, now, now .. '-' .. math.random())
        redis.call('EXPIRE', key, window)
        return {1, limit - currentRequests - 1, now + (window * 1000)}
      else
        return {0, 0, now + (window * 1000)}
      end
    `;

    try {
      const now = Date.now();
      const res = (await this.redis.eval(
        luaScript,
        1,
        `ratelimit:${key}`,
        limit,
        windowSeconds,
        now,
      )) as [number, number, number];

      const allowed = res[0] === 1;
      const remaining = res[1];
      const resetAt = res[2];

      if (!allowed) {
        this.stats.rateLimitHits += 1;
      }

      return { allowed, remaining, resetAt };
    } catch {
      return this.fallback.checkRateLimit(key, limit, windowSeconds);
    }
  }

  getStats(): CacheStats {
    const fallbackStats = this.fallback.getStats();
    return {
      hits: this.stats.hits + fallbackStats.hits,
      misses: this.stats.misses + fallbackStats.misses,
      sets: this.stats.sets + fallbackStats.sets,
      deletes: this.stats.deletes + fallbackStats.deletes,
      rateLimitHits: this.stats.rateLimitHits + fallbackStats.rateLimitHits,
    };
  }

  async close(): Promise<void> {
    try {
      await this.redis.quit();
    } catch {
      this.redis.disconnect();
    }
    await this.fallback.close();
  }
}

/**
 * Creates an appropriate cache client depending on whether a Valkey/Redis URL is provided.
 */
export function createCacheClient(connectionUrl?: string): CacheClient {
  if (connectionUrl && connectionUrl.trim() !== "") {
    const client = new ValkeyCacheClient(connectionUrl.trim());
    void client.connect();
    return client;
  }
  return new MemoryCacheClient();
}
