import { createHash } from 'crypto';
import type { Request, Response, NextFunction, RequestHandler } from 'express';
import type { IdempotencyOptions, IdempotencyRecord, IIdempotencyStore } from './types.js';

export * from './types.js';

const EXCLUDED_HEADERS = new Set([
  'connection',
  'keep-alive',
  'transfer-encoding',
  'date',
  'server',
  'x-powered-by',
  'content-length',
  'etag',
  'set-cookie',
]);

function getCacheableHeaders(headers: Record<string, any>): Record<string, string | string[]> {
  const cacheable: Record<string, string | string[]> = {};
  for (const [key, value] of Object.entries(headers)) {
    const lowerKey = key.toLowerCase();
    if (!EXCLUDED_HEADERS.has(lowerKey) && value !== undefined && value !== null) {
      cacheable[key] = value;
    }
  }
  return cacheable;
}

export function idempotency(options: IdempotencyOptions): RequestHandler {
  if (!options || !options.store) {
    throw new Error('A store strategy must be provided in idempotency options');
  }

  const store = options.store;
  const ttlSeconds = options.ttlSeconds ?? 86400; // 24 hours
  const headerName = options.headerName ?? 'Idempotency-Key';
  const enforceHeader = options.enforceHeader ?? false;
  const errorMessage = options.errorMessage ?? 'Request in progress';

  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    // 1. Check for the Idempotency-Key header.
    // The key can be look up case-insensitively using req.get()
    const idempotencyKey = req.get(headerName);

    if (!idempotencyKey) {
      if (enforceHeader) {
        res.status(400).json({ message: `${headerName} header is required` });
        return;
      }
      return next();
    }

    try {
      // 2. Hash the key (fingerprint) combining the key, method, path, and optional userId
      const userId = options.getUserId ? await options.getUserId(req) : undefined;
      const hashInput = `${idempotencyKey}:${req.method}:${req.path}:${userId || ''}`;
      const fingerprint = createHash('sha256').update(hashInput).digest('hex');

      // 3. Check the store
      const record = await store.get(fingerprint);

      // 4. If HIT (already processed): Return cached response immediately
      if (record) {
        if (record.status === 'completed') {
          res.status(record.statusCode || 200);
          
          if (record.headers) {
            for (const [name, val] of Object.entries(record.headers)) {
              if (val !== undefined) {
                res.set(name, val);
              }
            }
          }
          
          res.set('Idempotency-Cache', 'HIT');

          if (record.bodyType === 'buffer' && record.body) {
            res.send(Buffer.from(record.body, 'base64'));
          } else {
            res.send(record.body);
          }
          return;
        }

        // 5. If IN PROGRESS (locked): Return 409 Conflict
        if (record.status === 'started') {
          res.status(409).json({ message: errorMessage });
          return;
        }
      }

      // 6. If MISS (new request): Acquire lock
      const acquired = await store.setLock(fingerprint, ttlSeconds);
      if (!acquired) {
        // Double-check: another concurrent request succeeded in acquiring lock
        res.status(409).json({ message: errorMessage });
        return;
      }

      // Intercept Express res.send/json/end to capture response body (Decorator Pattern)
      const originalSend = res.send;
      const originalJson = res.json;
      const originalEnd = res.end;

      let capturedBody: any = undefined;

      res.send = function (body?: any): Response {
        if (capturedBody === undefined && (typeof body === 'string' || Buffer.isBuffer(body))) {
          capturedBody = body;
        }
        return originalSend.apply(this, arguments as any);
      };

      res.json = function (body?: any): Response {
        if (capturedBody === undefined) {
          capturedBody = JSON.stringify(body);
        }
        return originalJson.apply(this, arguments as any);
      };

      res.end = function (chunk?: any, encoding?: any, callback?: any): Response {
        if (capturedBody === undefined && chunk && (typeof chunk === 'string' || Buffer.isBuffer(chunk))) {
          capturedBody = chunk;
        }
        return originalEnd.apply(this, arguments as any);
      };

      let responseFinished = false;

      // Finish event listener: save response to store and release lock
      res.on('finish', async () => {
        responseFinished = true;
        const cacheable = options.shouldCache 
          ? options.shouldCache(res) 
          : (res.statusCode >= 200 && res.statusCode < 500);

        if (cacheable) {
          let serializedBody: string | undefined;
          let bodyType: 'string' | 'buffer' | undefined;

          if (Buffer.isBuffer(capturedBody)) {
            serializedBody = capturedBody.toString('base64');
            bodyType = 'buffer';
          } else if (typeof capturedBody === 'string') {
            serializedBody = capturedBody;
            bodyType = 'string';
          }

          const responseRecord: IdempotencyRecord = {
            status: 'completed',
            statusCode: res.statusCode,
            headers: getCacheableHeaders(res.getHeaders()),
            body: serializedBody,
            bodyType,
          };

          try {
            await store.set(fingerprint, responseRecord, ttlSeconds);
          } catch (err) {
            // Failure to save to cache shouldn't break an already finished client response
          }
        } else {
          // If not cacheable, delete the key so client can retry
          try {
            await store.delete(fingerprint);
          } catch (err) {
            // Ignore
          }
        }
      });

      // Close event listener: release lock if closed prematurely
      res.on('close', async () => {
        setTimeout(async () => {
          if (!responseFinished) {
            try {
              await store.delete(fingerprint);
            } catch (err) {
              // Ignore
            }
          }
        }, 0);
      });

      next();
    } catch (err) {
      next(err);
    }
  };
}
