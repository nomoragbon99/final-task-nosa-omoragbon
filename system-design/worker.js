import { Worker } from 'bullmq';
import Redis from 'ioredis';

const REDIS_HOST = process.env.REDIS_HOST || '127.0.0.1';
const REDIS_PORT = Number(process.env.REDIS_PORT) || 6379;

const redisConnection = new Redis({
  host: REDIS_HOST,
  port: REDIS_PORT,
  maxRetriesPerRequest: null
});

// ===========================================================================
// ===========================================================================
// *** PATTERN 1: ADAPTER PATTERN ***
// ===========================================================================
// The Adapter Pattern wraps incompatible legacy or external provider APIs
// (e.g., SendGrid, Twilio) behind a unified, polymorphic NotificationAdapter
// interface. This decouples our core domain logic from vendor-specific SDKs.
// ===========================================================================

// --- Abstract Base Adapter Interface ---
class NotificationAdapter {
  async send(recipient, message) {
    throw new Error('Method "send" must be implemented by concrete adapters.');
  }
}

// --- Fake External Email Provider (Simulates SendGrid / AWS SES) ---
class RawEmailVendorSdk {
  deliverEmail(toAddress, htmlBody) {
    return new Promise((resolve) => {
      setTimeout(() => {
        resolve({
          providerMessageId: `ses-${Date.now()}-${Math.floor(Math.random() * 10000)}`,
          status: 'SUCCESS_250_OK'
        });
      }, 80);
    });
  }
}

// Concrete Email Adapter
export class FakeEmailProviderAdapter extends NotificationAdapter {
  constructor() {
    super();
    this.vendorSdk = new RawEmailVendorSdk();
  }

  async send(recipient, message) {
    console.log(`[Adapter: Email] Dispatching to ${recipient}...`);
    const response = await this.vendorSdk.deliverEmail(recipient, message);
    console.log(`[Adapter: Email] Delivered successfully. Message ID: ${response.providerMessageId}`);
    return {
      success: true,
      channel: 'EMAIL',
      provider: 'SendGrid/SES Mock',
      providerId: response.providerMessageId
    };
  }
}

// --- Fake External SMS Provider (Simulates Twilio / Sinch Telecom Gateway) ---
class RawSmsTelecomApi {
  transmitSms(destinationE164, textContent) {
    return new Promise((resolve, reject) => {
      setTimeout(() => {
        // SIMULATE 30% NETWORK / CARRIER TIMEOUT ERROR
        const failureChance = Math.random();
        if (failureChance < 0.30) {
          return reject(new Error('SMS Gateway 503: Carrier connection timeout / upstream rate-limit'));
        }

        resolve({
          sid: `SM${Date.now()}${Math.floor(Math.random() * 1000)}`,
          status: 'queued_at_carrier'
        });
      }, 120);
    });
  }
}

// Concrete SMS Adapter
export class FakeSMSProviderAdapter extends NotificationAdapter {
  constructor() {
    super();
    this.telecomApi = new RawSmsTelecomApi();
  }

  async send(recipient, message) {
    console.log(`[Adapter: SMS] Dispatching to ${recipient}...`);
    // Will throw ~30% of the time to trigger the retry backoff mechanism
    const response = await this.telecomApi.transmitSms(recipient, message);
    console.log(`[Adapter: SMS] Carrier accepted. SID: ${response.sid}`);
    return {
      success: true,
      channel: 'SMS',
      provider: 'Twilio Mock',
      providerId: response.sid
    };
  }
}

// ===========================================================================
// ===========================================================================
// *** PATTERN 2: STRATEGY PATTERN ***
// ===========================================================================
// The Strategy Pattern encapsulates interchangeable channel routing
// algorithms. At runtime, the Strategy Context selects and executes the
// appropriate channel delivery strategy based on user preferences.
// ===========================================================================

// --- Delivery Strategy Context ---
export class NotificationRoutingStrategyContext {
  constructor() {
    // Strategy Registry mapping channel keys to their concrete adapters
    this.strategies = new Map();
    this.strategies.set('EMAIL', new FakeEmailProviderAdapter());
    this.strategies.set('SMS', new FakeSMSProviderAdapter());
  }

  /**
   * Executes the appropriate strategy dynamically based on user channel preference
   */
  async executeStrategy(channel, recipient, message) {
    const normalizedChannel = (channel || 'EMAIL').toUpperCase();
    const selectedStrategy = this.strategies.get(normalizedChannel);

    if (!selectedStrategy) {
      throw new Error(`[Strategy Context] No strategy registered for channel: "${channel}"`);
    }

    console.log(`[Strategy Pattern] Executing routing strategy for [${normalizedChannel}] -> ${recipient}`);
    return await selectedStrategy.send(recipient, message);
  }
}

// Instantiate the router strategy context
const routerContext = new NotificationRoutingStrategyContext();

// ===========================================================================
// ===========================================================================
// *** PATTERN 3: RETRY WITH EXPONENTIAL BACKOFF PATTERN ***
// ===========================================================================
// Configured below via BullMQ worker processing semantics.
// When an adapter throws an exception (such as the SMS 30% simulated carrier
// failure), the worker fails the current attempt. BullMQ intercepts the error
// and reschedules the job with exponential backoff:
// - Attempt 1: Immediate failure
// - Attempt 2: Scheduled after ~1,000ms (1s)
// - Attempt 3: Scheduled after ~2,000ms (2s)
// - If Attempt 3 fails: Marked permanently failed and moved to DLQ
// ===========================================================================

console.log('[Relay Worker] Initializing BullMQ Worker on queue: "notifications"...');

export const worker = new Worker(
  'notifications',
  async (job) => {
    const { userId, message, channel, contact, idempotencyKey } = job.data;
    const currentAttempt = job.attemptsMade + 1;
    const maxAttempts = job.opts.attempts || 3;

    console.log(`\n=================================================================`);
    console.log(`[Worker Processing] Job ID: ${job.id} | User: ${userId}`);
    console.log(`[RETRY PATTERN] Attempt ${currentAttempt} of ${maxAttempts} (Attempts Made: ${job.attemptsMade})`);
    console.log(`[Payload] IdempotencyKey: ${idempotencyKey} | Channel: ${channel}`);
    console.log(`=================================================================`);

    try {
      // Execute the Strategy Pattern to route to the correct Adapter
      const dispatchResult = await routerContext.executeStrategy(channel, contact, message);

      console.log(`[Worker Success] Job ${job.id} successfully delivered on attempt ${currentAttempt}.`);
      return dispatchResult;

    } catch (error) {
      console.error(`[RETRY PATTERN] [Attempt ${currentAttempt} FAILED]: ${error.message}`);

      if (currentAttempt < maxAttempts) {
        const nextDelayMs = 1000 * Math.pow(2, job.attemptsMade);
        console.warn(`[RETRY PATTERN] Will trigger exponential backoff retry in ~${nextDelayMs}ms.`);
      } else {
        console.error(`[RETRY PATTERN] Job ${job.id} has EXHAUSTED all ${maxAttempts} retry attempts. Moving to Dead Letter Queue.`);
      }

      // Re-throw error to signal BullMQ to trigger retry according to backoff policy
      throw error;
    }
  },
  {
    connection: redisConnection,
    concurrency: 10 // Concurrent worker threads
  }
);

// Worker Lifecycle Events
worker.on('completed', (job, result) => {
  console.log(`[BullMQ Event: COMPLETED] Job ${job.id} delivered via ${result.channel}`);
});

worker.on('failed', (job, err) => {
  console.log(`[BullMQ Event: FAILED] Job ${job?.id} failed with message: ${err.message}`);
});

worker.on('error', (err) => {
  console.error('[BullMQ Worker Error]', err);
});
