import type { Request, Response } from 'express';

export type IdempotencyRecordStatus = 'started' | 'completed';

export interface IdempotencyRecord {
  /**
   * Status of the request execution.
   * 'started' indicates a lock is held and processing is in progress.
   * 'completed' indicates the request has finished and the response is cached.
   */
  status: IdempotencyRecordStatus;

  /**
   * Cached HTTP status code (only present when status is 'completed').
   */
  statusCode?: number;

  /**
   * Cached response headers (only present when status is 'completed').
   */
  headers?: Record<string, string | string[] | undefined>;

  /**
   * Cached response body payload. Stored as string, JSON, or base64 (if buffer).
   */
  body?: string;

  /**
   * Tracks whether the original response body was a buffer or string.
   */
  bodyType?: 'string' | 'buffer';
}

export interface IIdempotencyStore {
  /**
   * Retrieve a record from the store.
   * Returns null if key does not exist or has expired.
   */
  get(key: string): Promise<IdempotencyRecord | null>;

  /**
   * Save a completed record to the store with a given TTL.
   */
  set(key: string, record: IdempotencyRecord, ttlSeconds: number): Promise<void>;

  /**
   * Try to atomically acquire a lock by setting status to 'started'.
   * Should return true if the lock was successfully acquired (key didn't exist).
   * Should return false if the lock already exists (or key is already present).
   */
  setLock(key: string, ttlSeconds: number): Promise<boolean>;

  /**
   * Delete a record or release a lock.
   */
  delete(key: string): Promise<void>;
}

export interface IdempotencyOptions {
  /**
   * The storage backend strategy (e.g. MemoryStore or RedisStore).
   */
  store: IIdempotencyStore;

  /**
   * Time to live in seconds for the stored records/locks.
   * Default: 86400 (24 hours).
   */
  ttlSeconds?: number;

  /**
   * Header name to extract the idempotency key from.
   * Default: 'Idempotency-Key'.
   */
  headerName?: string;

  /**
   * If true, throws 400 Bad Request if the idempotency key header is missing.
   * If false, bypasses idempotency checks and passes to next() when missing.
   * Default: false.
   */
  enforceHeader?: boolean;

  /**
   * Optional function to retrieve a user ID from the request.
   * Used as part of the SHA-256 fingerprint hash to prevent key collisions across users.
   */
  getUserId?: (req: Request) => string | undefined | Promise<string | undefined>;

  /**
   * Optional function to determine if a response should be cached based on the response.
   * Default: status codes between 200 and 499 (inclusive) are cached, 5xx are released (not cached).
   */
  shouldCache?: (res: Response) => boolean;

  /**
   * Optional custom message returned for conflict (409) when a request is in progress.
   * Default: 'Request in progress'.
   */
  errorMessage?: string;
}
