import type { IIdempotencyStore, IdempotencyRecord } from '../types.js';

export interface RedisClientLike {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ...args: any[]): Promise<any>;
  del(key: string): Promise<any>;
}

export interface RedisStoreOptions {
  /**
   * Prefix for all keys stored in Redis to avoid collisions with other data.
   * Default: 'idemp:'.
   */
  keyPrefix?: string;
}

export class RedisStore implements IIdempotencyStore {
  private readonly redis: RedisClientLike;
  private readonly keyPrefix: string;

  constructor(redisClient: RedisClientLike, options?: RedisStoreOptions) {
    if (!redisClient) {
      throw new Error('A Redis client instance must be provided to RedisStore');
    }
    this.redis = redisClient;
    this.keyPrefix = options?.keyPrefix ?? 'idemp:';
  }

  /**
   * Prepend the key prefix to avoid namespace collisions.
   */
  private getRedisKey(key: string): string {
    return `${this.keyPrefix}${key}`;
  }

  /**
   * Fetch a record from Redis.
   */
  async get(key: string): Promise<IdempotencyRecord | null> {
    const prefixedKey = this.getRedisKey(key);
    const val = await this.redis.get(prefixedKey);
    if (!val) {
      return null;
    }

    try {
      return JSON.parse(val) as IdempotencyRecord;
    } catch (err) {
      // In case of invalid JSON stored, return null
      return null;
    }
  }

  /**
   * Set/update a record in Redis with a TTL.
   */
  async set(key: string, record: IdempotencyRecord, ttlSeconds: number): Promise<void> {
    const prefixedKey = this.getRedisKey(key);
    const val = JSON.stringify(record);
    // Use SET key value EX ttl
    await this.redis.set(prefixedKey, val, 'EX', ttlSeconds);
  }

  /**
   * Atomically acquire a lock using Redis NX mode.
   * Sets status to 'started' only if key does not exist.
   * Returns true if lock was acquired, false otherwise.
   */
  async setLock(key: string, ttlSeconds: number): Promise<boolean> {
    const prefixedKey = this.getRedisKey(key);
    const val = JSON.stringify({ status: 'started' });
    
    // Set with expiration (EX) and Not-Exists (NX)
    const result = await this.redis.set(prefixedKey, val, 'EX', ttlSeconds, 'NX');
    
    // Depending on the Redis library, result might be string 'OK' or response code.
    // ioredis returns 'OK' on success, and null on failure.
    // node-redis might return OK or null.
    return result === 'OK' || result === true || result === 1;
  }

  /**
   * Delete record / release lock in Redis.
   */
  async delete(key: string): Promise<void> {
    const prefixedKey = this.getRedisKey(key);
    await this.redis.del(prefixedKey);
  }
}
