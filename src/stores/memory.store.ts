import type { IIdempotencyStore, IdempotencyRecord } from '../types.js';

interface MemoryStoreItem {
  record: IdempotencyRecord;
  expiresAt: number;
}

export interface MemoryStoreOptions {
  /**
   * The maximum number of records to keep in memory (LRU eviction).
   * Default: 1000.
   */
  maxSize?: number;
}

export class MemoryStore implements IIdempotencyStore {
  private readonly map = new Map<string, MemoryStoreItem>();
  private readonly maxSize: number;

  constructor(options?: MemoryStoreOptions) {
    this.maxSize = options?.maxSize ?? 1000;
  }

  /**
   * Retrieve record from the memory store.
   * If the record is expired, it is deleted and null is returned.
   * Refreshes the insertion order in the Map for LRU.
   */
  async get(key: string): Promise<IdempotencyRecord | null> {
    const item = this.map.get(key);
    if (!item) {
      return null;
    }

    if (Date.now() > item.expiresAt) {
      this.map.delete(key);
      return null;
    }

    // Refresh insertion order by deleting and re-inserting
    this.map.delete(key);
    this.map.set(key, item);

    return item.record;
  }

  /**
   * Store a record.
   * Refreshes insertion order and performs LRU eviction if maximum size is reached.
   */
  async set(key: string, record: IdempotencyRecord, ttlSeconds: number): Promise<void> {
    const expiresAt = Date.now() + ttlSeconds * 1000;
    
    // Delete first to refresh insertion order if it already exists
    this.map.delete(key);
    this.map.set(key, { record, expiresAt });

    this.evictIfNecessary();
  }

  /**
   * Atomically acquire lock.
   * Checks if key exists. If it exists and is expired, deletes it.
   * If it exists and is active, returns false.
   * Otherwise, inserts lock record and returns true.
   */
  async setLock(key: string, ttlSeconds: number): Promise<boolean> {
    const item = this.map.get(key);
    if (item) {
      if (Date.now() > item.expiresAt) {
        this.map.delete(key);
      } else {
        return false; // Lock already exists and is active
      }
    }

    const expiresAt = Date.now() + ttlSeconds * 1000;
    
    // Set lock
    this.map.set(key, {
      record: { status: 'started' },
      expiresAt,
    });

    this.evictIfNecessary();
    return true;
  }

  /**
   * Delete key / release lock.
   */
  async delete(key: string): Promise<void> {
    this.map.delete(key);
  }

  /**
   * Performs eviction of the least recently used element (the first element in Map iteration).
   */
  private evictIfNecessary(): void {
    if (this.map.size > this.maxSize) {
      const oldestKey = this.map.keys().next().value;
      if (oldestKey !== undefined) {
        this.map.delete(oldestKey);
      }
    }
  }

  /**
   * Helper method to inspect internal size (useful for tests).
   */
  _size(): number {
    return this.map.size;
  }

  /**
   * Helper method to clear store (useful for tests).
   */
  _clear(): void {
    this.map.clear();
  }
}
