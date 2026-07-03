import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { idempotency } from '../src/index.js';
import { MemoryStore } from '../src/stores/memory.store.js';
import { RedisStore } from '../src/stores/redis.store.js';

describe('express-idempotency middleware', () => {
  let memoryStore: MemoryStore;

  beforeEach(() => {
    memoryStore = new MemoryStore({ maxSize: 100 });
  });

  describe('Basic Workflow', () => {
    it('should process request normally when header is missing and enforceHeader is false', async () => {
      const app = express();
      const handler = vi.fn((req, res) => {
        res.json({ result: 'ok' });
      });

      app.use(idempotency({ store: memoryStore, enforceHeader: false }));
      app.post('/test', handler);

      const response = await request(app)
        .post('/test')
        .send({ amount: 100 });

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ result: 'ok' });
      expect(response.headers['idempotency-cache']).toBeUndefined();
      expect(handler).toHaveBeenCalledTimes(1);
    });

    it('should return 400 Bad Request when header is missing and enforceHeader is true', async () => {
      const app = express();
      const handler = vi.fn((req, res) => {
        res.json({ result: 'ok' });
      });

      app.use(idempotency({ store: memoryStore, enforceHeader: true }));
      app.post('/test', handler);

      const response = await request(app)
        .post('/test')
        .send({ amount: 100 });

      expect(response.status).toBe(400);
      expect(response.body.message).toContain('Idempotency-Key header is required');
      expect(handler).not.toHaveBeenCalled();
    });

    it('should cache and replay successful responses', async () => {
      const app = express();
      let callCount = 0;
      const handler = vi.fn((req, res) => {
        callCount++;
        res.set('Custom-Header', 'custom-value');
        res.json({ count: callCount });
      });

      app.use(idempotency({ store: memoryStore }));
      app.post('/test', handler);

      // First request (MISS)
      const res1 = await request(app)
        .post('/test')
        .set('Idempotency-Key', 'test-key-1')
        .send({ amount: 100 });

      expect(res1.status).toBe(200);
      expect(res1.body).toEqual({ count: 1 });
      expect(res1.headers['custom-header']).toBe('custom-value');
      expect(res1.headers['idempotency-cache']).toBeUndefined();
      expect(handler).toHaveBeenCalledTimes(1);

      // Second request (HIT)
      const res2 = await request(app)
        .post('/test')
        .set('Idempotency-Key', 'test-key-1')
        .send({ amount: 100 });

      expect(res2.status).toBe(200);
      expect(res2.body).toEqual({ count: 1 }); // Cached response body
      expect(res2.headers['custom-header']).toBe('custom-value'); // Cached response header
      expect(res2.headers['idempotency-cache']).toBe('HIT');
      expect(handler).toHaveBeenCalledTimes(1); // Handler should not be called again
    });

    it('should never cache or replay security-sensitive set-cookie headers', async () => {
      const app = express();
      const handler = vi.fn((req, res) => {
        res.cookie('session-id', 'secret-session-token');
        res.json({ status: 'authenticated' });
      });

      app.use(idempotency({ store: memoryStore }));
      app.post('/auth-action', handler);

      const res1 = await request(app)
        .post('/auth-action')
        .set('Idempotency-Key', 'auth-key')
        .send();

      expect(res1.status).toBe(200);
      expect(res1.headers['set-cookie']).toBeDefined(); // Cookie is set on first request

      const res2 = await request(app)
        .post('/auth-action')
        .set('Idempotency-Key', 'auth-key')
        .send();

      expect(res2.status).toBe(200);
      expect(res2.headers['idempotency-cache']).toBe('HIT');
      expect(res2.headers['set-cookie']).toBeUndefined(); // Cookie should NOT be replayed on hit
    });
  });

  describe('Concurrent Request Handling', () => {
    it('should return 409 Conflict if a request with same key is in progress', async () => {
      const app = express();
      const handler = vi.fn(async (req, res) => {
        // Slow down the request to simulate in-flight execution
        await new Promise((resolve) => setTimeout(resolve, 80));
        res.json({ result: 'slow-ok' });
      });

      app.use(idempotency({ store: memoryStore, errorMessage: 'Duplicate request in progress' }));
      app.post('/test', handler);

      // Send both requests concurrently
      const [res1, res2] = await Promise.all([
        request(app)
          .post('/test')
          .set('Idempotency-Key', 'concurrent-key')
          .send(),
        new Promise<any>((resolve) => {
          // Slight delay to ensure first request starts processing and gets lock
          setTimeout(async () => {
            const res = await request(app)
              .post('/test')
              .set('Idempotency-Key', 'concurrent-key')
              .send();
            resolve(res);
          }, 15);
        }),
      ]);

      expect(res1.status).toBe(200);
      expect(res1.body).toEqual({ result: 'slow-ok' });

      expect(res2.status).toBe(409);
      expect(res2.body.message).toBe('Duplicate request in progress');
      expect(handler).toHaveBeenCalledTimes(1);
    });
  });

  describe('Error Handling and Lock Release', () => {
    it('should not cache 5xx error responses and release lock', async () => {
      const app = express();
      let shouldError = true;
      const handler = vi.fn((req, res) => {
        if (shouldError) {
          res.status(500).json({ error: 'server crash' });
        } else {
          res.status(200).json({ result: 'recovered' });
        }
      });

      app.use(idempotency({ store: memoryStore }));
      app.post('/test', handler);

      // First request (fails, should delete lock)
      const res1 = await request(app)
        .post('/test')
        .set('Idempotency-Key', 'error-key')
        .send();

      expect(res1.status).toBe(500);
      expect(handler).toHaveBeenCalledTimes(1);

      // Allow request to proceed successfully now
      shouldError = false;

      // Second request (should hit handler again because lock was released)
      const res2 = await request(app)
        .post('/test')
        .set('Idempotency-Key', 'error-key')
        .send();

      expect(res2.status).toBe(200);
      expect(res2.body).toEqual({ result: 'recovered' });
      expect(handler).toHaveBeenCalledTimes(2);
    });

    it('should release lock if route handler throws an unhandled error', async () => {
      const app = express();
      let callCount = 0;
      app.use(idempotency({ store: memoryStore }));
      app.post('/test', (req, res, next) => {
        callCount++;
        if (callCount === 1) {
          throw new Error('Unhandled exception');
        }
        res.json({ result: 'success-second-time' });
      });

      // Error handler to prevent process crash
      app.use((err: any, req: any, res: any, next: any) => {
        res.status(500).json({ error: err.message });
      });

      const res1 = await request(app)
        .post('/test')
        .set('Idempotency-Key', 'crash-key')
        .send();

      expect(res1.status).toBe(500);

      const res2 = await request(app)
        .post('/test')
        .set('Idempotency-Key', 'crash-key')
        .send();

      expect(res2.status).toBe(200);
      expect(res2.body).toEqual({ result: 'success-second-time' });
    });
  });

  describe('Fingerprinting and User IDs', () => {
    it('should separate caches for different users using getUserId', async () => {
      const app = express();
      let callCount = 0;
      const handler = vi.fn((req, res) => {
        callCount++;
        res.json({ count: callCount });
      });

      app.use(
        idempotency({
          store: memoryStore,
          getUserId: (req) => req.headers['x-user-id'] as string,
        })
      );
      app.post('/test', handler);

      // Request for User A
      const resA1 = await request(app)
        .post('/test')
        .set('Idempotency-Key', 'shared-key')
        .set('x-user-id', 'user-A')
        .send();

      expect(resA1.status).toBe(200);
      expect(resA1.body).toEqual({ count: 1 });

      // Request for User B with the same Idempotency-Key (should be separate cache)
      const resB1 = await request(app)
        .post('/test')
        .set('Idempotency-Key', 'shared-key')
        .set('x-user-id', 'user-B')
        .send();

      expect(resB1.status).toBe(200);
      expect(resB1.body).toEqual({ count: 2 }); // Handler was run again

      // Cached Request for User A
      const resA2 = await request(app)
        .post('/test')
        .set('Idempotency-Key', 'shared-key')
        .set('x-user-id', 'user-A')
        .send();

      expect(resA2.status).toBe(200);
      expect(resA2.body).toEqual({ count: 1 }); // Cached A response

      expect(handler).toHaveBeenCalledTimes(2);
    });
  });

  describe('Memory Store LRU Eviction', () => {
    it('should evict the oldest key when size limit is exceeded', async () => {
      const lruStore = new MemoryStore({ maxSize: 2 });

      await lruStore.set('key1', { status: 'completed', body: 'one' }, 10);
      await lruStore.set('key2', { status: 'completed', body: 'two' }, 10);

      // Access key1 to make it most recently used
      await lruStore.get('key1');

      // Add key3, which should trigger eviction of key2 (since key1 was accessed)
      await lruStore.set('key3', { status: 'completed', body: 'three' }, 10);

      expect(await lruStore.get('key1')).not.toBeNull();
      expect(await lruStore.get('key3')).not.toBeNull();
      expect(await lruStore.get('key2')).toBeNull(); // Evicted!
    });
  });

  describe('Redis Store Strategy', () => {
    it('should interact correctly with the Redis Client Strategy', async () => {
      // Mock Redis Client
      const storeMap = new Map<string, string>();
      const mockRedisClient = {
        get: vi.fn(async (key: string) => {
          return storeMap.get(key) || null;
        }),
        set: vi.fn(async (key: string, value: string, ...args: any[]) => {
          const isNx = args.includes('NX');
          if (isNx && storeMap.has(key)) {
            return null; // nx fail
          }
          storeMap.set(key, value);
          return 'OK';
        }),
        del: vi.fn(async (key: string) => {
          storeMap.delete(key);
          return 1;
        }),
      };

      const redisStore = new RedisStore(mockRedisClient, { keyPrefix: 'test-prefix:' });

      // Test Lock
      const lockAcquired = await redisStore.setLock('lock-key', 60);
      expect(lockAcquired).toBe(true);
      expect(mockRedisClient.set).toHaveBeenCalledWith(
        'test-prefix:lock-key',
        JSON.stringify({ status: 'started' }),
        'EX',
        60,
        'NX'
      );

      // Concurrent Lock fails
      const lockAcquired2 = await redisStore.setLock('lock-key', 60);
      expect(lockAcquired2).toBe(false);

      // Store Completed
      await redisStore.set('lock-key', { status: 'completed', body: 'cached' }, 60);
      expect(mockRedisClient.set).toHaveBeenLastCalledWith(
        'test-prefix:lock-key',
        JSON.stringify({ status: 'completed', body: 'cached' }),
        'EX',
        60
      );

      // Get
      const val = await redisStore.get('lock-key');
      expect(val).toEqual({ status: 'completed', body: 'cached' });
      expect(mockRedisClient.get).toHaveBeenCalledWith('test-prefix:lock-key');

      // Delete
      await redisStore.delete('lock-key');
      expect(mockRedisClient.del).toHaveBeenCalledWith('test-prefix:lock-key');
      expect(await redisStore.get('lock-key')).toBeNull();
    });
  });
});
