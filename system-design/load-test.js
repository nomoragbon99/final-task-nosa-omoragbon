import http from 'k6/http';
import { check, sleep } from 'k6';

// ---------------------------------------------------------------------------
// K6 LOAD TEST CONFIGURATION: 100 Concurrent Virtual Users for 30 Seconds
// ---------------------------------------------------------------------------
export const options = {
  scenarios: {
    constant_request_rate: {
      executor: 'constant-vus',
      vus: 100,            // 100 concurrent virtual users
      duration: '30s',     // test runs for 30 seconds
    },
  },
  thresholds: {
    http_req_duration: ['p(95)<500', 'p(99)<1000'], // 95% of requests must complete under 500ms
    http_req_failed: ['rate<0.01'],                 // API failure rate should be less than 1%
  },
};

// ---------------------------------------------------------------------------
// HELPER: Generate RFC4122 v4 UUID in pure JavaScript for k6 runtime
// ---------------------------------------------------------------------------
function generateUuidV4() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

const TARGET_URL = __ENV.TARGET_URL || 'http://localhost:3000/notify';

// ---------------------------------------------------------------------------
// MAIN VIRTUAL USER EXECUTION LOOP
// ---------------------------------------------------------------------------
export default function () {
  // Randomly alternate user IDs between User 1 (SMS preference) and User 2 (Email preference)
  const randomUserId = Math.floor(Math.random() * 10) + 1;
  const uniqueIdempotencyKey = generateUuidV4();

  const payload = JSON.stringify({
    userId: randomUserId,
    message: `Verification code: ${Math.floor(100000 + Math.random() * 900000)} (Test transaction at ${new Date().toISOString()})`,
    idempotencyKey: uniqueIdempotencyKey,
  });

  const params = {
    headers: {
      'Content-Type': 'application/json',
      'Idempotency-Key': uniqueIdempotencyKey,
    },
  };

  const response = http.post(TARGET_URL, payload, params);

  // Assertions: 202 Accepted expected for new valid requests
  check(response, {
    'status is 202 Accepted': (r) => r.status === 202,
    'response has notificationId': (r) => {
      try {
        const json = JSON.parse(r.body);
        return json.notificationId !== undefined;
      } catch (e) {
        return false;
      }
    },
    'response has accepted status': (r) => {
      try {
        const json = JSON.parse(r.body);
        return json.status === 'ACCEPTED';
      } catch (e) {
        return false;
      }
    },
  });

  // Small pacing sleep between iterations
  sleep(0.1);
}
