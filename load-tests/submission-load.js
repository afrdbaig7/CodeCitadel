import http from 'k6/http';
import { check, sleep } from 'k6';

// Section 26 SLO Acceptance Target:
// - p95 run submission latency under 500 ms
// - Application error rate under 1% at offered load
export const options = {
  stages: [
    { duration: '20s', target: 10 },  // Ramp up
    { duration: '1m', target: 30 },   // Sustained load
    { duration: '20s', target: 50 },  // Burst peak
    { duration: '20s', target: 0 },   // Ramp down
  ],
  thresholds: {
    // SLO: p95 latency < 500ms
    http_req_duration: ['p(95)<500', 'p(99)<1000'],
    // SLO: <1% failure rate
    http_req_failed: ['rate<0.01'],
  },
};

const BASE_URL = __ENV.API_URL || 'http://localhost:3000';
const TOKEN = __ENV.AUTH_TOKEN || 'cc_load_test_token';

const SAMPLE_IMPACT_REPORT = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  root: '/workspace',
  base: { generatedAt: new Date().toISOString(), root: '/workspace' },
  changed: ['packages/core/src/index.ts'],
  graph: {
    modules: 12,
    edges: 24,
    testFiles: 4,
    externalImports: 8,
    outsideScope: 0,
    unresolved: [],
  },
  impacted: ['packages/core/test/index.test.ts'],
  tests: { selected: ['packages/core/test/index.test.ts'], notSelected: 3 },
  complete: true,
  incompleteReasons: [],
  limitations: ['Load simulation report'],
};

export default function () {
  const payload = JSON.stringify({
    schemaVersion: 1,
    origin: 'user-ci',
    kind: 'impact',
    repository: {
      name: 'load-test-repo',
      commit: `commit_${__VU}_${__ITER}`,
      branch: 'main',
    },
    capturedAt: new Date().toISOString(),
    report: SAMPLE_IMPACT_REPORT,
    artifacts: [],
  });

  const params = {
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${TOKEN}`,
    },
  };

  const res = http.post(`${BASE_URL}/api/v1/reports`, payload, params);

  check(res, {
    'status is 202 (accepted)': (r) => r.status === 202,
    'has run id': (r) => {
      try {
        const body = JSON.parse(r.body);
        return body && body.run && typeof body.run.id === 'string';
      } catch {
        return false;
      }
    },
  });

  // Paced user think-time between submissions
  sleep(0.5);
}
