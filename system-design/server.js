import express from 'express';
import { Queue } from 'bullmq';
import Redis from 'ioredis';
import { randomUUID } from 'crypto';

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const REDIS_HOST = process.env.REDIS_HOST || '127.0.0.1';
const REDIS_PORT = Number(process.env.REDIS_PORT) || 6379;

// ---------------------------------------------------------------------------
// REDIS CONNECTION & IN-MEMORY FALLBACK
// ---------------------------------------------------------------------------
const redisConnection = new Redis({
  host: REDIS_HOST,
  port: REDIS_PORT,
  maxRetriesPerRequest: null // Required by BullMQ
});

redisConnection.on('error', (err) => {
  console.warn('[Redis] Connection warning (using in-memory fallback if unavailable):', err.message);
});

// In-memory set fallback if Redis is unavailable or for local standalone testing
const inMemoryIdempotencyStore = new Set();

// ---------------------------------------------------------------------------
// BULLMQ NOTIFICATION QUEUE SETUP WITH RETRY CONFIGURATION
// ---------------------------------------------------------------------------
// ===========================================================================
// *** PATTERN: RETRY WITH EXPONENTIAL BACKOFF (QUEUE PRODUCER CONFIG) ***
// Jobs added to this queue automatically configure up to 3 retry attempts
// with exponential backoff (1000ms base, doubling on each failure: 1s, 2s, 4s).
// ===========================================================================
const notificationQueue = new Queue('notifications', {
  connection: redisConnection,
  defaultJobOptions: {
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 1000 // 1 second initial delay
    },
    removeOnComplete: true,
    removeOnFail: false
  }
});

// ---------------------------------------------------------------------------
// MOCK USER PREFERENCES SERVICE
// ---------------------------------------------------------------------------
/**
 * Simulated user preferences lookup
 * User 1 -> SMS
 * User 2 -> EMAIL
 * Defaults to EMAIL for others
 */
function getUserPreferences(userId) {
  const preferencesDb = {
    '1': { channel: 'SMS', contact: '+1-555-0199' },
    '2': { channel: 'EMAIL', contact: 'user2@example.com' },
    'user_1': { channel: 'SMS', contact: '+1-555-0101' },
    'user_2': { channel: 'EMAIL', contact: 'user2@example.com' }
  };

  return preferencesDb[String(userId)] || {
    channel: Number(userId) % 2 === 1 ? 'SMS' : 'EMAIL',
    contact: `user_${userId}@relay.internal`
  };
}

// ---------------------------------------------------------------------------
// IDEMPOTENCY CHECK HELPER (Redis SETNX with TTL + In-Memory Fallback)
// ---------------------------------------------------------------------------
async function checkAndLockIdempotencyKey(key) {
  const redisKey = `idemp:${key}`;
  const TTL_SECONDS = 86400; // 24-hour deduplication window

  try {
    // Redis SET key value EX seconds NX: Sets key only if it does not already exist
    const result = await redisConnection.set(redisKey, 'LOCKED', 'EX', TTL_SECONDS, 'NX');
    if (result === 'OK') {
      return { isDuplicate: false };
    }
    return { isDuplicate: true };
  } catch (err) {
    // Graceful fallback to in-memory set if Redis is offline
    if (inMemoryIdempotencyStore.has(key)) {
      return { isDuplicate: true };
    }
    inMemoryIdempotencyStore.add(key);
    return { isDuplicate: false };
  }
}

// ---------------------------------------------------------------------------
// API ENDPOINT: POST /notify
// ---------------------------------------------------------------------------
app.post('/notify', async (req, res) => {
  try {
    const { userId, message } = req.body;
    const idempotencyKey = req.body.idempotencyKey || req.headers['idempotency-key'] || randomUUID();

    if (!userId || !message) {
      return res.status(400).json({
        error: 'Validation Error',
        message: 'userId and message fields are required'
      });
    }

    // 1. Idempotency Check (SETNX)
    const { isDuplicate } = await checkAndLockIdempotencyKey(idempotencyKey);
    if (isDuplicate) {
      return res.status(409).json({
        status: 'DUPLICATE_REQUEST_IGNORED',
        message: 'A notification with this idempotency key was already received and processed.',
        idempotencyKey
      });
    }

    // 2. Fetch User Channel Preferences
    const preference = getUserPreferences(userId);

    // 3. Dispatch Job to BullMQ Background Queue
    const job = await notificationQueue.add(
      'dispatch_notification',
      {
        idempotencyKey,
        userId,
        message,
        channel: preference.channel,
        contact: preference.contact,
        enqueuedAt: new Date().toISOString()
      },
      {
        jobId: idempotencyKey // Guarantees BullMQ-level deduplication
      }
    );

    // 4. Return Fast 202 Accepted Response
    return res.status(202).json({
      status: 'ACCEPTED',
      notificationId: job.id,
      idempotencyKey,
      channel: preference.channel,
      recipient: preference.contact,
      message: 'Notification successfully validated and queued for delivery.'
    });

  } catch (error) {
    console.error('[API Error] Failed to enqueue notification:', error);
    return res.status(500).json({
      error: 'Internal Server Error',
      details: error.message
    });
  }
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'HEALTHY', timestamp: new Date().toISOString() });
});

app.listen(PORT, () => {
  console.log(`[Relay Ingestion API] Server running on http://localhost:${PORT}`);
  console.log(`[Relay Ingestion API] POST /notify ready to accept traffic`);
});
