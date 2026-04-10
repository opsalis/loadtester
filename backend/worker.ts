import http from 'http';
import https from 'https';
import { URL } from 'url';

/**
 * LoadTester Worker — HTTP load generator
 *
 * Runs as a k8s Job. Generates HTTP traffic at a target RPS,
 * reports per-second metrics back to the API server.
 *
 * Environment:
 *   TARGET_URL   — URL to load test
 *   RPS          — Target requests per second
 *   DURATION     — Test duration in seconds
 *   RAMP_UP      — Ramp-up time in seconds
 *   REGION       — Worker region label
 *   TEST_ID      — Test identifier
 *   API_URL      — API server URL for reporting
 */

const TARGET_URL = process.env.TARGET_URL || '';
const RPS = parseInt(process.env.RPS || '100');
const DURATION = parseInt(process.env.DURATION || '60');
const RAMP_UP = parseInt(process.env.RAMP_UP || '5');
const REGION = process.env.REGION || 'unknown';
const TEST_ID = process.env.TEST_ID || '';
const API_URL = process.env.API_URL || 'http://loadtester-api:3400';

interface SecondMetrics {
  requests: number;
  errors: number;
  bytes: number;
  latencies: number[];
  statusCodes: Record<number, number>;
}

// --- Percentile calculation ---
function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil(sorted.length * (p / 100)) - 1;
  return sorted[Math.max(0, idx)];
}

// --- Single HTTP request ---
function makeRequest(url: URL, agent: http.Agent | https.Agent): Promise<{ latency: number; status: number; bytes: number; error: string | null }> {
  const start = Date.now();
  const client = url.protocol === 'https:' ? https : http;

  return new Promise((resolve) => {
    const req = client.request(url, {
      method: 'GET',
      agent,
      timeout: 30000,
      headers: {
        'User-Agent': 'LoadTester/1.0',
        'Accept': '*/*'
      }
    }, (res) => {
      let bytes = 0;
      res.on('data', (chunk) => { bytes += chunk.length; });
      res.on('end', () => {
        resolve({
          latency: Date.now() - start,
          status: res.statusCode || 0,
          bytes,
          error: null
        });
      });
    });

    req.on('error', (err) => {
      resolve({ latency: Date.now() - start, status: 0, bytes: 0, error: err.message });
    });

    req.on('timeout', () => {
      req.destroy();
      resolve({ latency: 30000, status: 0, bytes: 0, error: 'timeout' });
    });

    req.end();
  });
}

// --- Report metrics to API ---
async function reportMetrics(second: number, metrics: SecondMetrics): Promise<void> {
  const sorted = [...metrics.latencies].sort((a, b) => a - b);
  const avg = sorted.length > 0 ? sorted.reduce((a, b) => a + b, 0) / sorted.length : 0;

  const payload = JSON.stringify({
    test_id: TEST_ID,
    region: REGION,
    second,
    rps: metrics.requests,
    latency_avg: Math.round(avg * 100) / 100,
    latency_p50: percentile(sorted, 50),
    latency_p95: percentile(sorted, 95),
    latency_p99: percentile(sorted, 99),
    errors: metrics.errors,
    bytes: metrics.bytes,
    status_codes: metrics.statusCodes
  });

  return new Promise((resolve) => {
    const url = new URL(`${API_URL}/v1/internal/metrics`);
    const client = url.protocol === 'https:' ? https : http;
    const req = client.request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
    }, () => resolve());
    req.on('error', () => resolve());
    req.write(payload);
    req.end();
  });
}

// --- Report completion ---
async function reportComplete(): Promise<void> {
  const payload = JSON.stringify({ test_id: TEST_ID, region: REGION });
  return new Promise((resolve) => {
    const url = new URL(`${API_URL}/v1/internal/complete`);
    const client = url.protocol === 'https:' ? https : http;
    const req = client.request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
    }, () => resolve());
    req.on('error', () => resolve());
    req.write(payload);
    req.end();
  });
}

// --- Main load generation loop ---
async function runLoadTest(): Promise<void> {
  if (!TARGET_URL || !TEST_ID) {
    console.error('TARGET_URL and TEST_ID are required');
    process.exit(1);
  }

  const url = new URL(TARGET_URL);
  console.log(`Worker starting — Region: ${REGION}, Target: ${TARGET_URL}, RPS: ${RPS}, Duration: ${DURATION}s`);

  // Create keep-alive agent
  const agentOptions = { keepAlive: true, maxSockets: Math.min(RPS, 1000), timeout: 30000 };
  const agent = url.protocol === 'https:'
    ? new https.Agent(agentOptions)
    : new http.Agent(agentOptions);

  for (let second = 0; second < DURATION; second++) {
    // Calculate current RPS (with ramp-up)
    const rampFactor = second < RAMP_UP ? (second + 1) / RAMP_UP : 1;
    const currentRps = Math.floor(RPS * rampFactor);
    const intervalMs = 1000 / currentRps;

    const metrics: SecondMetrics = {
      requests: 0,
      errors: 0,
      bytes: 0,
      latencies: [],
      statusCodes: {}
    };

    const secondStart = Date.now();
    const promises: Promise<void>[] = [];

    for (let i = 0; i < currentRps; i++) {
      const delay = i * intervalMs;
      const p = new Promise<void>((resolve) => {
        setTimeout(async () => {
          const result = await makeRequest(url, agent);
          metrics.requests++;
          metrics.latencies.push(result.latency);
          metrics.bytes += result.bytes;
          if (result.error) {
            metrics.errors++;
          }
          if (result.status) {
            metrics.statusCodes[result.status] = (metrics.statusCodes[result.status] || 0) + 1;
          }
          resolve();
        }, delay);
      });
      promises.push(p);
    }

    // Wait for all requests in this second to complete (with timeout)
    await Promise.race([
      Promise.all(promises),
      new Promise(r => setTimeout(r, 5000)) // 5s max wait per second
    ]);

    // Report this second's metrics
    await reportMetrics(second, metrics);

    const elapsed = Date.now() - secondStart;
    console.log(`Second ${second + 1}/${DURATION}: ${metrics.requests} req, ${metrics.errors} err, avg ${
      metrics.latencies.length > 0 ? Math.round(metrics.latencies.reduce((a, b) => a + b, 0) / metrics.latencies.length) : 0
    }ms`);

    // Wait for the remainder of this second
    if (elapsed < 1000) {
      await new Promise(r => setTimeout(r, 1000 - elapsed));
    }
  }

  // Clean up
  agent.destroy();

  // Report completion
  await reportComplete();
  console.log(`Worker ${REGION} completed test ${TEST_ID}`);
  process.exit(0);
}

// Run
runLoadTest().catch((err) => {
  console.error(`Worker fatal error: ${err.message}`);
  process.exit(1);
});
