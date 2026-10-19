# System Design Document: Relay (High-Scale Multi-Channel Notification Platform)

**System Name:** Relay  
**Author:** Staff Systems & Infrastructure Engineer  
**Scale Target:** 50,000,000 notifications / day with burst factor $10\times$  
**Channels Supported:** Mobile Push (APNs, FCM), Email (SendGrid, AWS SES), SMS (Twilio, Sinch, Infobip)  
**Status:** Approved for Implementation

---

## 1. Requirements

### 1.1 Functional Requirements
1. **Multi-Channel Delivery:** Ingest, route, and dispatch notifications across Mobile Push (iOS APNs, Android FCM), Transactional & Marketing Email, and SMS.
2. **Dynamic Routing & Channel Prioritization:** Intelligently select channels based on user preferences, urgency/category (transactional vs. promotional), deliverability rates, and cost tier.
3. **Template Management & Localization:** Support dynamic parameter substitution, internationalized templates ($>50$ locales), and channel-specific markup (HTML, plaintext, rich push payloads).
4. **User Preferences & Quiet Hours:** Honor opt-out matrices, frequency caps, and timezone-aware quiet hours (e.g., delay promotional messages between 22:00 and 08:00 local time).
5. **Deduplication & Idempotency:** Guarantee that identical client requests (retries, race conditions) never result in duplicate external deliveries within a configurable sliding window (default: 24 hours).
6. **Delivery Tracking & Webhooks:** Capture real-time delivery lifecycle states (`queued`, `dispatched`, `delivered`, `opened`, `bounced`, `failed`) and emit webhooks to downstream internal consumers.

### 1.2 Non-Functional Requirements
1. **High Availability:** $99.99\%$ service availability ($< 52.6$ minutes downtime/year) across API ingress and dispatch pipelines.
2. **Throughput & Burst Tolerance:** Handle an average of $578\text{ msgs/sec}$, with sustained burst tolerance of up to $6,000\text{ msgs/sec}$ during flash sales or critical security alerts.
3. **Latency Guarantees (p99):**
   * High-priority/Transactional (e.g., OTP, 2FA, password resets, fraud alerts): $\le 2.0\text{ seconds}$ end-to-end delivery from ingestion to provider dispatch.
   * Low-priority/Marketing (e.g., newsletters, promotions): $\le 15\text{ minutes}$ delivery window.
4. **Durability & At-Least-Once Delivery:** Zero data loss for accepted notifications. If downstream upstream vendors (APNs, Twilio, SendGrid) degrade, Relay persists and retries safely without message drops.
5. **Security & Regulatory Compliance:** End-to-end encryption for sensitive payloads (PII/PHI), tokenized delivery targets (phone numbers, email hashes), GDPR right-to-erasure support, and SOC2/HIPAA audit trails.

---

## 2. Back-of-the-Envelope Estimates

### 2.1 Traffic & Ingestion Rates
* **Daily Volume:** $50,000,000\text{ notifications/day}$
* **Average Delivery Rate:**
  $$\text{QPS}_{\text{avg}} = \frac{50,000,000}{86,400\text{ seconds}} \approx 578.7\text{ messages/second}$$
* **Peak Traffic (10× Burst Factor):**
  $$\text{QPS}_{\text{peak}} = 578.7 \times 10 \approx 5,800\text{ messages/second} \approx 6,000\text{ msgs/sec}$$
* **Ingress API Request Throughput:** Assuming batch ingestion ratio of $1.5$ notifications per request:
  $$\text{API QPS}_{\text{avg}} \approx 385\text{ req/s},\quad \text{API QPS}_{\text{peak}} \approx 4,000\text{ req/s}$$

### 2.2 Channel Distribution
| Channel | Percentage | Daily Volume | Avg QPS | Peak QPS |
| :--- | :--- | :--- | :--- | :--- |
| **Push (APNs / FCM)** | $60\%$ | $30,000,000$ | $347\text{ msg/s}$ | $3,500\text{ msg/s}$ |
| **Email (SES / SendGrid)** | $30\%$ | $15,000,000$ | $174\text{ msg/s}$ | $1,750\text{ msg/s}$ |
| **SMS (Twilio / Sinch)** | $10\%$ | $5,000,000$ | $58\text{ msg/s}$ | $600\text{ msg/s}$ |

### 2.3 Storage Estimates
* **Average Ingestion Payload Size:** $2.5\text{ KB}$ (metadata, recipient IDs, template variables, localization keys).
* **Rendered Message Sizes:**
  * Push: $1.0\text{ KB}$
  * Email: $25\text{ KB}$ (HTML + plaintext)
  * SMS: $300\text{ bytes}$
* **Daily Ingestion Raw Storage:**
  $$\text{Storage}_{\text{raw}} = 50,000,000 \times 2.5\text{ KB} = 125,000,000\text{ KB} \approx 125\text{ GB/day}$$
* **Daily Delivery Audit & Event Log Storage:**
  * Each message generates ~3 state transitions (`ACCEPTED`, `DISPATCHED`, `DELIVERED`).
  * 3 events $\times 500\text{ bytes} = 1.5\text{ KB}$ per notification.
  * Audit logs: $50\text{M} \times 1.5\text{ KB} = 75\text{ GB/day}$.
* **Total Storage Accumulation:**
  * Hot Data (PostgreSQL + Redis, 7-day retention): $\approx (125 + 75) \times 7 = 1.4\text{ TB}$.
  * Warm Data (Partitioned cold tables, 90-day retention): $\approx 200\text{ GB} \times 90 = 18\text{ TB}$.
  * Cold Data (Parquet in S3 / GCS for analytics & compliance, 3-year retention): $\approx 73\text{ TB/year}$.

### 2.4 Bandwidth & Network Throughput
* **Ingress Bandwidth (API Gateway):**
  $$\text{Bandwidth}_{\text{in, avg}} = 578\text{ msg/s} \times 2.5\text{ KB} = 1.44\text{ MB/s} \approx 11.5\text{ Mbps}$$
  $$\text{Bandwidth}_{\text{in, peak}} = 6,000\text{ msg/s} \times 2.5\text{ KB} = 15.0\text{ MB/s} \approx 120\text{ Mbps}$$
* **Egress Bandwidth (Dispatch to Third-Party Gateways):**
  * Push: $3,500\text{ msg/s} \times 1\text{ KB} = 3.5\text{ MB/s} = 28\text{ Mbps}$
  * Email: $1,750\text{ msg/s} \times 25\text{ KB} = 43.75\text{ MB/s} = 350\text{ Mbps}$
  * SMS: $600\text{ msg/s} \times 0.3\text{ KB} = 0.18\text{ MB/s} = 1.44\text{ Mbps}$
  * **Total Peak Egress:** $\approx 47.5\text{ MB/s} \approx 380\text{ Mbps}$

---

## 3. API Design

### 3.1 Standards & Protocols
* RESTful JSON over HTTP/2 with TLS 1.3.
* Mandatory idempotency header: `Idempotency-Key: <UUIDv4 | Client-Supplied-Key>`.
* Mandatory authentication: `Authorization: Bearer <API_KEY>` with fine-grained RBAC scopes (`notifications:write`, `templates:read`).

---

### 3.2 Endpoint: Dispatch Notification (Single / Batch)
`POST /v1/notifications`

#### Request Headers
```http
POST /v1/notifications HTTP/2
Host: api.relay.internal
Authorization: Bearer sec_live_9f81a7b8e390c2
Idempotency-Key: 7b3e15f2-9c3a-4db7-8b01-57434fae8902
Content-Type: application/json
X-Correlation-ID: corr-8b61e29c
```

#### Request Payload
```json
{
  "recipient_id": "usr_99814a2bc1",
  "category": "security_alert",
  "priority": "HIGH",
  "channels": ["PUSH", "EMAIL", "SMS"],
  "routing_policy": "FALLBACK_ON_FAILURE",
  "template_id": "tpl_suspicious_login_v2",
  "template_variables": {
    "user_name": "Alex",
    "ip_address": "192.0.2.45",
    "device": "macOS Safari",
    "timestamp": "2026-10-19T21:40:00Z",
    "auth_code": "481092"
  },
  "quiet_hours_override": true,
  "ttl_seconds": 300
}
```

#### Response (202 Accepted)
```json
{
  "status": "ACCEPTED",
  "notification_id": "notif_01JAX7K89M2N8R4E1V8C39G7PY",
  "idempotency_key": "7b3e15f2-9c3a-4db7-8b01-57434fae8902",
  "created_at": "2026-10-19T21:40:02.104Z",
  "evaluated_channel": "PUSH",
  "lifecycle_state": "QUEUED"
}
```

---

### 3.3 Endpoint: Get Notification Status
`GET /v1/notifications/{notification_id}`

#### Response (200 OK)
```json
{
  "notification_id": "notif_01JAX7K89M2N8R4E1V8C39G7PY",
  "recipient_id": "usr_99814a2bc1",
  "category": "security_alert",
  "priority": "HIGH",
  "status": "DELIVERED",
  "attempts": [
    {
      "channel": "PUSH",
      "provider": "APNS",
      "status": "DELIVERED",
      "provider_reference_id": "apns-msg-2849182390",
      "timestamp": "2026-10-19T21:40:03.210Z",
      "latency_ms": 1106
    }
  ],
  "completed_at": "2026-10-19T21:40:03.210Z"
}
```

---

### 3.4 Endpoint: Update Recipient Preferences & Quiet Hours
`PUT /v1/recipients/{recipient_id}/preferences`

#### Request Payload
```json
{
  "timezone": "America/New_York",
  "quiet_hours": {
    "enabled": true,
    "start_time": "22:00",
    "end_time": "08:00",
    "exceptions": ["security_alert", "transactional_otp"]
  },
  "channel_preferences": {
    "marketing": ["EMAIL"],
    "order_updates": ["PUSH", "EMAIL"],
    "security_alert": ["PUSH", "SMS", "EMAIL"]
  },
  "frequency_caps": {
    "marketing_daily_max": 2
  }
}
```

#### Response (200 OK)
```json
{
  "recipient_id": "usr_99814a2bc1",
  "updated_at": "2026-10-19T21:42:10.000Z",
  "preferences_version": 4
}
```

---

## 4. Data Model

### 4.1 PostgreSQL Relational Schema
We partition historical logs by month using declarative range partitioning.

```sql
-- Core notification ledger
CREATE TABLE notifications (
    id VARCHAR(36) NOT NULL, -- ULID for chronological sortability
    idempotency_key VARCHAR(128) NOT NULL,
    recipient_id VARCHAR(64) NOT NULL,
    category VARCHAR(48) NOT NULL,
    priority VARCHAR(16) NOT NULL, -- HIGH, MEDIUM, LOW
    status VARCHAR(24) NOT NULL,   -- PENDING, PROCESSING, DELIVERED, FAILED, SUPPRESSED
    payload JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    scheduled_for TIMESTAMPTZ,
    PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);

-- Monthly partition definition example
CREATE TABLE notifications_2026_10 PARTITION OF notifications
    FOR VALUES FROM ('2026-10-01 00:00:00+00') TO ('2026-11-01 00:00:00+00');

-- Unique constraint ensuring idempotency per recipient/window
CREATE UNIQUE INDEX uq_notif_idempotency 
    ON notifications (idempotency_key, created_at);

CREATE INDEX idx_notif_recipient 
    ON notifications (recipient_id, created_at DESC);

-- Transactional Outbox Table for safe event publishing
CREATE TABLE outbox_events (
    id BIGSERIAL PRIMARY KEY,
    aggregate_type VARCHAR(64) NOT NULL,
    aggregate_id VARCHAR(64) NOT NULL,
    event_type VARCHAR(64) NOT NULL,
    payload JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    processed_at TIMESTAMPTZ
);
CREATE INDEX idx_outbox_unprocessed ON outbox_events (id) WHERE processed_at IS NULL;

-- Delivery attempt ledger for audit and debugging
CREATE TABLE notification_dispatches (
    dispatch_id VARCHAR(36) NOT NULL,
    notification_id VARCHAR(36) NOT NULL,
    channel VARCHAR(16) NOT NULL, -- PUSH, EMAIL, SMS
    provider VARCHAR(32) NOT NULL, -- APNS, FCM, SENDGRID, TWILIO
    attempt_number INT NOT NULL DEFAULT 1,
    status VARCHAR(24) NOT NULL,   -- SENT, DELIVERED, BOUNCED, FAILED
    provider_response_id VARCHAR(128),
    error_code VARCHAR(64),
    latency_ms INT,
    dispatched_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (dispatch_id, dispatched_at)
) PARTITION BY RANGE (dispatched_at);

-- User Preferences & Channel Opt-outs
CREATE TABLE recipient_preferences (
    recipient_id VARCHAR(64) PRIMARY KEY,
    timezone VARCHAR(48) NOT NULL DEFAULT 'UTC',
    quiet_hours_enabled BOOLEAN NOT NULL DEFAULT FALSE,
    quiet_hours_start TIME,
    quiet_hours_end TIME,
    preferences_json JSONB NOT NULL DEFAULT '{}'::jsonb,
    version INT NOT NULL DEFAULT 1,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

### 4.2 Redis In-Memory Schemas
Redis serves as the low-latency caching and coordination layer.

| Key Pattern | Redis Data Type | TTL | Purpose |
| :--- | :--- | :--- | :--- |
| `idemp:{hash(key)}` | `String` (with NX lock) | $86,400\text{ s}$ (24h) | Atomic check-and-set idempotency filter |
| `pref:{recipient_id}` | `Hash` | $3,600\text{ s}$ (1h) | Cached preferences, quiet hours, and timezone |
| `freq:{recipient_id}:{category}:{date}` | `String` (INCR) | $86,400\text{ s}$ | Rate limiting / frequency cap enforcement |
| `circuit:breaker:{provider}` | `Hash` | None | Real-time failure counters and circuit state |
| `quiet_queue:{recipient_id}` | `Sorted Set` (score = release timestamp) | Variable | Delayed jobs held during quiet hours |

---

## 5. High-Level Architecture & Data Flow

### 5.1 Architecture Diagram
```
                     +---------------------------------------+
                     |         Clients / Microservices       |
                     +---------------------------------------+
                                         |
                                         | HTTPS (mTLS / API Key)
                                         v
                     +---------------------------------------+
                     |       Cloudflare CDN & Envoy LB       |
                     +---------------------------------------+
                                         |
                                         v
                 +-----------------------------------------------+
                 |             Relay Ingestion API               |
                 |  - Token validation  - Schema enforcement     |
                 |  - Idempotency check (Redis NX)               |
                 +-----------------------------------------------+
                         |                               |
          (Atomic Outbox)|                               |(Cache Lookups)
                         v                               v
                 +---------------+               +---------------+
                 |  PostgreSQL   |               |     Redis     |
                 | (Master / Obox|               | (Cluster/LRU) |
                 +---------------+               +---------------+
                         |
           (Debezium CDC | Tail Outbox)
                         v
       +===================================================+
       |             Apache Kafka Event Backbone           |
       |  - notifications.raw.high   (Partitioned by Key)  |
       |  - notifications.raw.normal                       |
       +===================================================+
             |                     |                     |
             v                     v                     v
   +------------------+  +------------------+  +------------------+
   | Priority Router  |  | Quiet Hour Delay |  | Frequency Cap    |
   | & Template Engine|  | Scheduler Engine |  | Validator        |
   +------------------+  +------------------+  +------------------+
             \                     |                    /
              +--------------------+-------------------+
                                   |
                                   v
       +===================================================+
       |             Channel-Specific Kafka Topics         |
       |  - dispatch.push   - dispatch.email   - dispatch.sms
       +===================================================+
             |                     |                     |
             v                     v                     v
     +---------------+     +---------------+     +---------------+
     | Push Dispatch |     | Email Dispatch|     | SMS Dispatch  |
     |   Workers     |     |    Workers    |     |    Workers    |
     | (APNs / FCM)  |     | (SES/SendGrid)|     | (Twilio/Sinch)|
     +---------------+     +---------------+     +---------------+
             |                     |                     |
             +---------------------+---------------------+
                                   |
                      (Delivery Status Callbacks)
                                   v
                     +---------------------------+
                     |   Webhook / Status Router |
                     |   -> Updates PostgreSQL   |
                     |   -> Metrics to Datadog   |
                     +---------------------------+
```

### 5.2 Step-by-Step Data Flow
1. **Ingress & Idempotency Check:** The client calls `POST /v1/notifications`. Envoy terminates TLS and forwards to the Ingestion API. The Ingestion API executes an atomic `SET idemp:{key} "PROCESSING" EX 86400 NX` in Redis. If the key exists, it returns the cached response or a `409 Conflict`.
2. **Transactional Outbox Write:** The Ingestion service validates the schema and writes the notification record and corresponding event into PostgreSQL inside a single ACID database transaction. It immediately returns `220 Accepted` with the ULID.
3. **Kafka Publishing via CDC:** A Debezium connector streams new rows from `outbox_events` directly into Kafka topic `notifications.raw.high` or `notifications.raw.normal` with $< 20\text{ ms}$ lag.
4. **Resolution & Pipeline Routing:**
   * **Rule Evaluator:** Pulls user preferences from Redis. If missing, fetches from PostgreSQL read replica and backfills cache.
   * **Quiet Hour Engine:** Computes the recipient's local time. If within quiet hours and the notification is not tagged `quiet_hours_override`, the message is diverted to a Redis Sorted Set `quiet_queue` scheduled for release at `quiet_hours_end`.
   * **Strategy Pattern Router:** Selects the delivery strategy (e.g., Push first; fallback to SMS if push token invalid).
   * **Template Hydration:** The template engine compiles the variables, markdown, and localized strings.
5. **Channel Dispatch Workers:** Workers consume from channel-specific Kafka topics (`dispatch.push`, `dispatch.sms`, `dispatch.email`). Workers use dedicated provider adapters with built-in circuit breakers and rate limiters.
6. **External Provider Handshake:** The adapter posts the message to the external vendor (e.g., APNs HTTP/2 multiplexed socket, Twilio REST API).
7. **Status & Analytics:** Upstream responses and provider status webhooks stream into an internal feedback queue, updating the `notification_dispatches` table and firing real-time Grafana/Datadog metrics.

---

## 6. Deep Dives

### 6.1 Preventing Duplicate Sends (Strict Idempotency Across the Distributed Chain)
In high-throughput distributed systems, duplicate sends occur due to client retries on network timeouts, queue redeliveries, consumer crashes before ACK, or provider retry policies. Relay implements a **3-Layer Deduplication Barrier**:

```
Client Request ──> [Layer 1: Redis Distributed Lock & Cache]
                          │ (Key missing -> Acquired lock)
                          ▼
                   [Layer 2: PostgreSQL Unique Constraint on Ledger]
                          │ (Committed atomically with Outbox)
                          ▼
                   [Layer 3: Pre-Dispatch In-Flight Deduplication Token]
                          │ (Provider-level idempotency key injection)
                          ▼
                   External Provider (Twilio, SendGrid, APNs)
```

1. **Layer 1: Edge Redis Deduplication (Transient Filter)**
   * When a request arrives with an `Idempotency-Key: X`, the API computes `key_hash = SHA256(client_id + ":" + X)`.
   * It runs a Redis Lua script:
     ```lua
     local status = redis.call("GET", KEYS[1])
     if status then
         return status
     else
         redis.call("SET", KEYS[1], "IN_FLIGHT", "EX", 86400)
         return nil
     end
     ```
   * If `status == "COMPLETED"`, Redis returns the cached payload, bypassing downstream processing entirely.
2. **Layer 2: Database Relational Constraint (Durable Barrier)**
   * In the event of a Redis node reboot or split-brain cache eviction, the PostgreSQL unique index `uq_notif_idempotency` on `(idempotency_key, created_at)` catches collisions during the initial insertion. Duplicate inserts trigger an error handled gracefully by the ingress worker.
3. **Layer 3: Provider-Level Deduplication Key Injection**
   * Relay passes the internal `notification_id` (ULID) directly to upstream vendors supporting idempotency (e.g., SendGrid's `batch_id`, Stripe-style idempotency keys, or FCM's `collapse_key`). If an upstream dispatch worker crashes mid-flight and redelivers the job, the vendor identifies the duplicate token and drops the send.

---

### 6.2 Respecting User Quiet Hours
Quiet hours prevent notifications (marketing, non-critical updates) from waking users during sleep hours. The challenge is handling diverse global timezones, daylight saving transitions, and dynamic user schedule overrides efficiently at 6,000 QPS.

#### Algorithm & Architecture for Quiet Hours:
```
                                 Notification Incoming
                                          │
                                          ▼
                         Is Priority == HIGH or Override == True?
                                    /           \
                           [YES]   /             \  [NO]
                                  /               \
                                 v                 v
                       Immediate Dispatch    Fetch User Timezone &
                                             Quiet Window from Redis
                                                   │
                                                   ▼
                                         Calculate Current Local Time:
                                          t_local = NOW() in User_TZ
                                                   │
                                                   ▼
                                        Is t_local within [Start, End)?
                                                /        \
                                       [NO]    /          \    [YES]
                                              /            \
                                             v              v
                                      Immediate       Calculate Release
                                      Dispatch        Timestamp (t_release)
                                                            │
                                                            ▼
                                                      Enqueue to Redis
                                                      Sorted Set (ZADD)
                                                            │
                                                            ▼
                                                   [Cron Sweeper / Dequeuer]
```

1. **Timezone Evaluation:**
   * Recipient profiles cache IANA timezones (e.g., `Africa/Lagos`, `America/New_York`) rather than fixed UTC offsets to automatically handle Daylight Saving Time (DST).
   * High-priority categories (`security_alert`, `transactional_otp`) automatically bypass quiet hours.
2. **The Delayed Execution Queue (Redis Sorted Set + Kafka Delay Bucket):**
   * If a notification falls in quiet hours, the system calculates the exact epoch millisecond timestamp when quiet hours end (`t_release`).
   * The job is placed into a Redis Sorted Set (`ZADD quiet_hour_jobs <t_release> <job_json>`).
   * **Scale Optimization:** For massive volumes, Redis Sorted Sets are partitioned into 16 shards by `hash(recipient_id) % 16` to prevent lock contention.
3. **High-Precision Sweeper:**
   * A distributed sweeper daemon (running every 5 seconds) queries the sorted set using `ZRANGEBYSCORE key -inf <NOW()> LIMIT 0 500`.
   * Pulled jobs are atomically removed via `ZREM` and pushed directly back into the primary Kafka channel topic for immediate compilation and delivery.

---

## 7. Design Patterns Applied

| Pattern | Architectural Location | Implementation Mechanism & Rationale |
| :--- | :--- | :--- |
| **Adapter Pattern** | SMS / Email / Push Provider Gateways | Normalizes incompatible third-party vendor interfaces (Twilio vs. Sinch vs. Infobip) under a unified `SmsProviderAdapter` interface with standard `.send()` signatures. Enables plug-and-play addition of new telecom providers without rewriting business logic. |
| **Strategy Pattern** | Channel Router & Delivery Orchestration | Selects the optimal dispatch strategy (`CostOptimizedStrategy`, `HighReliabilityFallbackStrategy`, `ChannelCascadeStrategy`) at runtime based on message priority, network conditions, and provider health. |
| **Transactional Outbox Pattern** | Ingestion Service & Database Persistence | Guarantees atomic consistency between PostgreSQL database writes and message broker publication. Eliminates dual-write failure vulnerabilities by committing the message state to `outbox_events` before publishing to Kafka via CDC (Debezium). |
| **Retry with Exponential Backoff & Jitter** | Dispatch Worker Network Calls | Implements Decorrelated Jitter algorithms ($t_{\text{wait}} = \min(t_{\text{max}}, \text{random}(t_{\text{base}}, t_{\text{previous}} \times 3))$) for transient provider errors (HTTP 429, 502, 503, 504) to avoid thundering herd issues against upstream vendors. |
| **Circuit Breaker Pattern** | External Vendor Egress Sockets | Implemented via Netflix Hystrix / Resilience4j style states (`CLOSED`, `OPEN`, `HALF_OPEN`). If error rate to Twilio exceeds $15\%$ over a 30-second sliding window, the circuit opens, instantly re-routing traffic to fallback provider Sinch without timing out in-flight worker threads. |

---

## 8. Scaling Plan (From 1k to 10M Users)

```
Scale Growth Timeline & Architectural Maturation:

 1k Users                     100k Users                   1M Users                     10M Users
 (5k msgs/day)                (500k msgs/day)              (5M msgs/day)                (50M msgs/day)
 ┌─────────────────┐          ┌─────────────────┐          ┌─────────────────┐          ┌─────────────────┐
 │ Monolith App    │          │ Decoupled App   │          │ Microservices   │          │ Partitioned Hub │
 │ Postgres DB     │   ───>   │ Postgres + Redis│   ───>   │ Kafka Event Bus │   ───>   │ Sharded DBs     │
 │ Background Cron │          │ BullMQ / Celery │          │ Dynamic Autoscal│          │ Geo-Distributed │
 └─────────────────┘          └─────────────────┘          └─────────────────┘          └─────────────────┘
```

### Stage 1: 1,000 Users (~5,000 msgs/day | ~0.06 QPS)
* **Architecture:** Monolithic application (Node.js / Go) running on 2 lightweight cloud instances behind an Application Load Balancer.
* **Database:** Single PostgreSQL RDS instance (`db.t4g.small`). Outbox and queue handled using PostgreSQL `SKIP LOCKED` or simple Redis BullMQ.
* **Providers:** Single provider per channel (Twilio for SMS, SendGrid for Email, APNs/FCM direct).

### Stage 2: 100,000 Users (~500,000 msgs/day | ~6 QPS avg, 60 QPS burst)
* **Architecture:** Decoupled Ingestion API and Background Dispatch Workers.
* **Database:** PostgreSQL RDS (`db.r6g.large`) with a read-replica for preference and status lookups. Redis Cluster for idempotency checking and rate-limiting.
* **Queuing:** Managed message queue (AWS SQS or RabbitMQ) with separate queues for High vs. Normal priority.
* **Fault Tolerance:** Multi-provider fallback added for critical channels (SendGrid $\to$ AWS SES).

### Stage 3: 1,000,000 Users (~5,000,000 msgs/day | ~60 QPS avg, 600 QPS burst)
* **Architecture:** Microservices deployed on Kubernetes (EKS / GKE) with Horizontal Pod Autoscaling (HPA) driven by queue depth metrics.
* **Queuing:** Migration from SQS to Apache Kafka to handle partition-ordered processing and high fan-out rates.
* **Database:** Partitioning of notifications tables by week/month. Read-heavy preferences cached in Redis with a 95% cache hit ratio.
* **Resilience:** Circuit breakers and provider-level rate-limiting actively balancing carrier limits.

### Stage 4: 10,000,000 Users (~50,000,000 msgs/day | ~600 QPS avg, 6,000 QPS burst)
* **Architecture:** Fully event-driven, multi-region ingress architecture. Debezium CDC for zero-loss outbox extraction.
* **Database:** Sharded PostgreSQL clusters (sharded by `recipient_id_hash`), combined with monthly range partitioning and auto-tiering to S3 Parquet/Iceberg cold storage.
* **Kafka Topology:** Dedicated Kafka clusters with multi-AZ replication, tuned for high compression (Zstandard) and zero log-compaction lag.
* **Edge Routing:** Global Anycast DNS and Envoy ingress proxies terminating connections closest to user backends.

---

## 9. Caching, Replication, and Sharding

### 9.1 Caching Strategy
* **Cache-Aside with Proactive Invalidation for Preferences:**
  * Read: Ingestion workers read preferences from Redis (`pref:{recipient_id}`). On cache miss, read from PostgreSQL read-replica and populate Redis with $1\text{ hour}$ TTL.
  * Write: Updating user preferences writes to PostgreSQL and atomically invalidates `pref:{recipient_id}` in Redis.
* **Idempotency Cache:** Write-Through semantic via Redis `SET ... NX`.
* **Templates & Localization:** Stored in an in-memory L1 cache inside each worker process (LRU cache with 5-minute TTL) with an L2 cache in Redis to eliminate DB queries during high-speed batch sends.

### 9.2 Replication Strategy
* **PostgreSQL:**
  * **Primary (Writer):** Deployed in Multi-AZ configuration with synchronous replication to a standby instance for zero-RPO failover.
  * **Read-Replicas:** 3 asynchronous read-replicas distributed across multiple availability zones. Routed through PgBouncer connection poolers for low-overhead connection re-use.
* **Redis Cluster:**
  * 6-node Redis Cluster (3 Masters, 3 Replicas) with auto-failover via Redis Sentinel. Ingestion keys partitioned across 16,384 hash slots.
* **Kafka Replication:**
  * Replication factor = 3 (`min.insync.replicas = 2`), ensuring zero data loss if an entire availability zone suffers an outage.

### 9.3 Sharding Strategy
When user data and historical records exceed single-node limits at 10M+ users:
* **Sharding Key:** `hash(recipient_id) % N_SHARDS` (default: 32 logical shards across 4 physical PostgreSQL clusters).
* **Benefits:** Guarantees that all notifications, preference updates, and dispatch histories for a given user reside on the same database node, eliminating cross-shard distributed transactions.
* **Re-Sharding Strategy:** Virtual vnodes mapping to physical instances, allowing shard migration via live logical replication without system downtime.

---

## 10. Failure Modes and Mitigations

| # | Failure Scenario | Impact | Detection Mechanism | Automated / Architectural Mitigation |
| :- | :--- | :--- | :--- | :--- |
| **1** | Primary SMS Provider (Twilio) major outage | SMS deliveries stall; queues back up across all channels | Synthetic health probes fail; error rate $> 15\%$ in 30s | **Circuit Breaker trips to `OPEN`:** Router activates Adapter Pattern to divert SMS traffic to secondary carrier (Sinch/Infobip) within 5 seconds. |
| **2** | Redis Cluster Node Crash / Split-Brain | Loss of in-flight idempotency locks; risk of duplicate sends | Sentinel heartbeat timeout; cluster health alerts | Redis Sentinel promotes replica to master in $< 3\text{ s}$. Layer 2 PostgreSQL unique index blocks duplicate writes until cache recovers. |
| **3** | Kafka Broker disk saturation during burst | Consumers stall; ingestion API cannot publish new events | Disk utilization alert ($> 80\%$); broker write backpressure | Producer backpressure engages; dynamic retention policy drops non-critical debug topics; broker storage auto-scales via AWS EBS volumes. |
| **4** | Push Certificate (APNs) expires or gets revoked | 100% of iOS push notifications fail | Elevated 403/400 APNs status codes logged by workers | Automated certificate rotation via HashiCorp Vault; worker alert fires; push queue pauses and buffers in Kafka until new cert loads without dropping jobs. |
| **5** | Thundering Herd on Database from Cache Flush | PostgreSQL CPU spikes to 100%; connection pool exhaustion | DB CPU $> 85\%$; PgBouncer queue latency spikes | SingleFlight / Mutex lock on cache misses: only 1 worker queries DB for a missing key while others await cache fill; PgBouncer limits active server connections. |
| **6** | Malformed Template Variable Crash | Worker processes panic and enter CrashLoopBackOff | Crash metrics; unhandled exception alerts in Sentry | Sandboxed template parser (Handlebars/Liquid) with strict schema validation; panics catch and divert poisoned message to a Dead Letter Queue (DLQ). |
| **7** | Client fires infinite loop of notifications | Queue inundation; downstream budget & resource depletion | Ingestion rate limiter triggers 429 Too Many Requests | Token Bucket algorithm enforced at API Gateway per `client_id` and per `recipient_id`. Malicious/errant clients are throttled automatically. |
| **8** | Debezium CDC Connector lag / crash | Outbox events remain in DB; Kafka receives no new tasks | Consumer lag monitoring on outbox table ($> 5,000$ events) | Alert triggers auto-restart of Kafka Connect task; if CDC fails, secondary polling worker process picks up unprocessed outbox rows after 2 minutes. |
| **9** | Downstream Email Provider Rate Limit (SES 429) | Transactional emails delayed; worker threads blocked | Upstream 429 rate limit responses captured in metrics | Rate-limiting Token Bucket in worker adapter matches provider quotas; messages re-queued to Kafka with exponential backoff delay topic. |
| **10** | Database Primary Node Hardware Failure | Write operations halted; Ingestion API returns errors | Aurora / RDS failover event; health check 500s | Multi-AZ automatic failover promotes standby replica to primary in $< 35\text{ s}$. Ingestion API temporarily buffers in local memory/spooler before flushing. |

---

## 11. Architectural Trade-offs

1. **Transactional Outbox via CDC vs. Direct Ingestion-to-Kafka Writes:**
   * *Compromise:* Writing to PostgreSQL first and extracting via Debezium CDC introduces a nominal $\sim 15\text{–}30\text{ ms}$ propagation latency compared to posting directly from the API Gateway to Kafka.
   * *Justification:* Guarantees absolute consistency between our persistent system of record and event broker. Eliminates dual-write split-brain scenarios where an API returns success to a client but crashes before Kafka receives the record.
2. **At-Least-Once Delivery vs. Exactly-Once Processing:**
   * *Compromise:* We architected for At-Least-Once delivery coupled with aggressive deduplication, rather than strict distributed Exactly-Once semantics (which require two-phase commits).
   * *Justification:* True distributed exactly-once delivery across external third-party networks (cellular carriers, Apple APNs) is physically impossible due to the Two Generals' Problem. Focusing on idempotency at each boundary achieves identical outcomes without a 60% throughput penalty.
3. **Partitioning by `recipient_id` vs. Global FIFO Queuing:**
   * *Compromise:* Notifications are strictly ordered only per recipient, not globally across the entire system.
   * *Justification:* Global FIFO ordering at 6,000 QPS creates massive lock bottlenecks and single-partition choke points in Kafka. Per-user ordering matches human expectations (User A's OTP arrives in order; User A and User B do not block each other).
4. **Relational Database (PostgreSQL) vs. Pure NoSQL (DynamoDB / Cassandra):**
   * *Compromise:* Managing horizontal sharding and partition lifecycle in PostgreSQL requires more operational discipline than a fully managed NoSQL engine like DynamoDB.
   * *Justification:* Relational integrity, ACID outbox guarantees, complex multi-column indexing (for compliance queries and audits), and predictable storage costs make PostgreSQL superior for financial and transactional notification ledgers.
5. **Memory-First Cache (Redis) for Quiet Hours vs. Persistent Disk Scheduling:**
   * *Compromise:* Storing delayed quiet-hour jobs in Redis Sorted Sets consumes RAM rather than cheap disk storage.
   * *Justification:* Sub-millisecond insertion, deletion, and range queries allow the system to evaluate, schedule, and release tens of thousands of delayed messages without incurring high disk I/O seek overhead on primary databases.

---

## 12. Rough Infrastructure Cost Estimate (at 100,000 Users Scale)

At **100,000 registered users**, generating approximately **500,000 notifications per day** ($\approx 6\text{ QPS avg}$, $\approx 60\text{ QPS peak}$), the estimated monthly cloud infrastructure cost (AWS baseline, US-East-1) is detailed below:

| Component | AWS Resource Specification | Units | Unit Cost / Mo | Total Cost / Month |
| :--- | :--- | :--- | :--- | :--- |
| **API Ingestion & Core Services** | ECS Fargate (`2 vCPU, 4 GB RAM`) | 4 Tasks (Multi-AZ) | $\$35.00$ | $\$140.00$ |
| **Channel Dispatch Workers** | ECS Fargate (`2 vCPU, 4 GB RAM`) | 6 Tasks (Auto-scale) | $\$35.00$ | $\$210.00$ |
| **Application Load Balancer** | AWS ALB (Traffic + LCU processing) | 1 ALB | $\$28.00$ | $\$28.00$ |
| **Primary Relational Database** | Amazon RDS PostgreSQL (`db.r6g.large`, Multi-AZ) | 1 Primary + Standby | $\$260.00$ | $\$260.00$ |
| **RDS Read-Replica** | Amazon RDS PostgreSQL (`db.r6g.large`, Single-AZ) | 1 Replica | $\$130.00$ | $\$130.00$ |
| **Database Storage & Backups** | Provisioned GP3 Storage (500 GB + Snapshots) | 500 GB | $\$0.115\text{ / GB}$ | $\$57.50$ |
| **In-Memory Cache & Locks** | Amazon ElastiCache for Redis (`cache.m6g.large`, Multi-AZ) | 2 Nodes | $\$98.00$ | $\$196.00$ |
| **Message Broker** | Amazon Managed Streaming for Kafka (Amazon MSK - 2 x `kafka.m5.large`) or Amazon SQS* | MSK Cluster | $\$280.00$ | $\$280.00$ |
| **Cold Storage & Audit Archive** | Amazon S3 Standard + Glacier Lifecycle (2 TB accumulated) | 2 TB | $\$0.023\text{ / GB}$ | $\$46.00$ |
| **Network Data Transfer & Egress** | Inter-AZ & Internet Egress (~1.5 TB/month) | 1.5 TB | $\$0.09\text{ / GB}$ | $\$135.00$ |
| **Monitoring, Logs & Traces** | Amazon CloudWatch Logs + Metrics (or Datadog Core) | Baseline usage | Lump sum | $\$120.00$ |
| **Total Estimated Infrastructure Cost** | | | | **$\approx \$1,602.50\text{ / month}$** |

*\*Note: At 100k users, substituting Amazon MSK with standard Amazon SQS ($500\text{k msgs/day} \times 30\text{ days} = 15\text{M requests} \approx \$6.00/\text{mo}$) reduces total infrastructure spend to **$\approx \$1,328.50 / \text{month}$**, offering a highly cost-effective runway before introducing full Kafka clusters.*
