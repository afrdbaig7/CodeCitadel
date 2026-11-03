import http from 'k6/http';
import { check, sleep } from 'k6';

// Read-through cache & metrics load test profile (Milestone R5 / Section 26)
export const options = {
  stages: [
    { duration: '15s', target: 20 },
    { duration: '45s', target: 100 }, // High-concurrency read throughput
    { duration: '15s', target: 0 },
  ],
  thresholds: {
    // Read cache acceleration target: p95 read latency < 80ms
    'http_req_duration{endpoint:run_detail}': ['p(95)<80'],
    'http_req_duration{endpoint:metrics}': ['p(95)<50'],
    http_req_failed: ['rate<0.005'],
  },
};

const BASE_URL = __ENV.API_URL || 'http://localhost:3000';
const TOKEN = __ENV.AUTH_TOKEN || 'cc_load_test_token';
const KNOWN_RUN_ID = __ENV.RUN_ID || 'run_seed_001';

export default function () {
  const params = {
    headers: {
      Authorization: `Bearer ${TOKEN}`,
    },
  };

  // 1. Fetch run detail (cached read path)
  const detailRes = http.get(`${BASE_URL}/api/v1/runs/${KNOWN_RUN_ID}`, {
    ...params,
    tags: { endpoint: 'run_detail' },
  });

  check(detailRes, {
    'detail status is 200 or 404': (r) => r.status === 200 || r.status === 404,
  });

  // 2. Fetch operational telemetry metrics
  const metricsRes = http.get(`${BASE_URL}/api/v1/metrics`, {
    ...params,
    tags: { endpoint: 'metrics' },
  });

  check(metricsRes, {
    'metrics status is 200': (r) => r.status === 200,
    'metrics returns status ok': (r) => {
      try {
        const body = JSON.parse(r.body);
        return body && body.status === 'ok';
      } catch {
        return false;
      }
    },
  });

  sleep(0.2);
}
