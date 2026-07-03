# express-idempotency

A lightweight, robust, and type-safe Express middleware to prevent duplicate request processing (e.g. double-charges on payments) using Idempotency Keys. 

Built with strict adherence to **SOLID**, **DRY**, and **KISS** principles. Features zero unnecessary dependencies.

## Features

- **Middleware Pipeline (Chain of Responsibility):** Drop-in Express middleware.
- **Storage Backend (Strategy Pattern):** Easily swap storage engines. Comes out of the box with:
  - `MemoryStore`: High-performance in-memory cache using JS `Map` and a custom Least Recently Used (LRU) eviction algorithm.
  - `RedisStore`: Atomic locking and caching using Redis (compatible with `ioredis` or any Redis-like client).
- **Response Capture (Decorator Pattern):** Intercepts `res.json()`, `res.send()`, and `res.end()` to capture response status, headers, and body automatically without modifying route code.
- **Fingerprinting:** Prevent key collisions across routes/users by hashing the `Idempotency-Key` along with the HTTP method, route path, and an optional `userId`.
- **Fault-Tolerant:** Safely deletes locks and releases keys on unhandled errors, client aborts, or server error statuses (5xx) so clients can safely retry.

---

## Installation

```bash
npm install express-idempotency
# If you are using RedisStore, install ioredis:
npm install ioredis
```

---

## Usage

### 1. In-Memory Store (LRU)

```typescript
import express from 'express';
import { idempotency } from 'express-idempotency';
import { MemoryStore } from 'express-idempotency/stores';

const app = express();

app.use(idempotency({
  store: new MemoryStore({ maxSize: 1000 }),
  ttlSeconds: 86400, // Cache for 24 hours
  enforceHeader: false, // If true, throws 400 Bad Request if Idempotency-Key is missing
}));

app.post('/payments', (req, res) => {
  res.status(201).json({ success: true, txnId: 'txn_12345' });
});
```

### 2. Redis Store (Using Connection String)

To use Redis, configure your client using your connection string, and pass the client instance to `RedisStore`. This allows you to configure timeouts, TLS, connection pools, and reuse the Redis connection across your application:

```typescript
import express from 'express';
import { idempotency } from 'express-idempotency';
import { RedisStore } from 'express-idempotency/stores';
import Redis from 'ioredis';

const app = express();

// Initialize ioredis with your Redis connection string (URI)
const redisClient = new Redis('redis://:your_password@localhost:6379/0');

app.use(idempotency({
  store: new RedisStore(redisClient, { keyPrefix: 'my-app:' }),
  ttlSeconds: 86400, // Cache for 24 hours
  // Tie idempotency keys to user accounts to prevent key collisions across users:
  getUserId: (req) => req.headers['x-user-id'] as string | undefined,
}));

app.post('/orders', (req, res) => {
  res.json({ orderId: 'ord_98765', status: 'created' });
});
```

---

## API Reference

### `idempotency(options)`

Middleware creator. Takes the following options:

| Option | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `store` | `IIdempotencyStore` | *Required* | Storage strategy to use (`MemoryStore` or `RedisStore`). |
| `ttlSeconds` | `number` | `86400` (24h) | Time-to-live in seconds for cached responses and locks. |
| `headerName` | `string` | `'Idempotency-Key'` | Header to inspect for the idempotency key. |
| `enforceHeader` | `boolean` | `false` | If `true`, returns `400 Bad Request` if the header is missing. |
| `getUserId` | `(req) => string \| Promise<string>` | `undefined` | Extracts user ID to lock request scope to a specific user. |
| `shouldCache` | `(res) => boolean` | `status < 500` | Predicate checking if a status code should be cached (5xx is not cached by default). |
| `errorMessage` | `string` | `'Request in progress'` | Custom message returned for concurrent conflict requests (409). |

### Custom Storage Strategy

You can implement your own strategy by implementing the `IIdempotencyStore` interface:

```typescript
import { IIdempotencyStore, IdempotencyRecord } from 'express-idempotency';

class CustomStore implements IIdempotencyStore {
  async get(key: string): Promise<IdempotencyRecord | null> {
    // get from DB
  }
  async set(key: string, record: IdempotencyRecord, ttlSeconds: number): Promise<void> {
    // save to DB
  }
  async setLock(key: string, ttlSeconds: number): Promise<boolean> {
    // atomically set lock (status: 'started') and return true if key did not exist
  }
  async delete(key: string): Promise<void> {
    // delete key
  }
}
```

---

## License

MIT
