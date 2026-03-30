'use strict';

const http = require('http');
const https = require('https');
const { WebSocket } = require('ws');

// ─── Config ───────────────────────────────────────────────────────────────────
const MASTER_URL = process.env.MASTER_URL || 'ws://master:4002/ws';
const WORKER_LOCATION = process.env.WORKER_LOCATION || 'default';
const RECONNECT_INTERVAL_MS = 5_000;
const REPORT_INTERVAL_MS = 1_000;

// ─── State ────────────────────────────────────────────────────────────────────
let workerId = null;
let ws = null;
let activeTest = null;

// ─── HTTP agents (keep-alive for realistic load) ──────────────────────────────
const httpAgent  = new http.Agent({ keepAlive: true, maxSockets: Infinity });
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: Infinity });

// ─── Latency percentile helper ────────────────────────────────────────────────
function percentile(sorted, pct) {
  if (!sorted.length) return 0;
  const idx = Math.max(0, Math.ceil(sorted.length * pct / 100) - 1);
  return sorted[idx];
}

// ─── Single HTTP request ──────────────────────────────────────────────────────
function makeRequest(targetUrl) {
  return new Promise(resolve => {
    const start = Date.now();
    const mod = targetUrl.startsWith('https') ? https : http;
    const agent = targetUrl.startsWith('https') ? httpsAgent : httpAgent;

    const req = mod.get(targetUrl, { agent }, res => {
      let bytes = 0;
      res.on('data', chunk => (bytes += chunk.length));
      res.on('end', () => resolve({ ok: res.statusCode < 400, latency: Date.now() - start, bytes, status: res.statusCode }));
    });
    req.on('error', () => resolve({ ok: false, latency: Date.now() - start, bytes: 0, status: 0 }));
    req.setTimeout(15_000, () => { req.destroy(); });
  });
}

// ─── Load runner ──────────────────────────────────────────────────────────────
async function runLoad(job) {
  const { test_id, target_url, vus, duration_seconds, ramp_up_seconds = 5 } = job;
  const startTime = Date.now();
  const endTime = startTime + duration_seconds * 1000;
  const rampEndTime = startTime + ramp_up_seconds * 1000;

  // Per-second bucket
  let bucket = { rps: 0, errors: 0, latencies: [], bytes: 0 };

  // Report ticker
  const ticker = setInterval(() => {
    if (!activeTest) return;
    const sorted = bucket.latencies.slice().sort((a, b) => a - b);
    const avg = sorted.length ? sorted.reduce((a, b) => a + b, 0) / sorted.length : 0;
    const report = {
      type: 'metrics',
      test_id,
      rps: bucket.rps,
      latency_avg: +avg.toFixed(2),
      latency_p50: +percentile(sorted, 50).toFixed(2),
      latency_p95: +percentile(sorted, 95).toFixed(2),
      latency_p99: +percentile(sorted, 99).toFixed(2),
      errors: bucket.errors,
      bytes: bucket.bytes,
      timestamp: Date.now(),
      location: WORKER_LOCATION,
    };
    send(report);
    bucket = { rps: 0, errors: 0, latencies: [], bytes: 0 };
  }, REPORT_INTERVAL_MS);

  // VU loop — each VU runs sequentially (one request at a time per VU)
  const vuTasks = Array.from({ length: vus }, (_, i) => (async () => {
    // Ramp-up stagger: spread VU starts across ramp_up_seconds
    const stagger = Math.floor((i / vus) * ramp_up_seconds * 1000);
    await new Promise(r => setTimeout(r, stagger));

    while (Date.now() < endTime && activeTest) {
      const result = await makeRequest(target_url);
      if (!activeTest) break;
      bucket.rps++;
      bucket.latencies.push(result.latency);
      bucket.bytes += result.bytes;
      if (!result.ok) bucket.errors++;
    }
  })());

  await Promise.all(vuTasks);
  clearInterval(ticker);

  if (activeTest) {
    send({ type: 'complete', test_id, location: WORKER_LOCATION, ts: Date.now() });
  }
  activeTest = null;
  console.log(`[worker] test ${test_id} finished`);
}

// ─── WebSocket ────────────────────────────────────────────────────────────────
function send(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(obj));
  }
}

function connect() {
  console.log(`[worker] connecting to master: ${MASTER_URL}`);
  ws = new WebSocket(MASTER_URL);

  ws.on('open', () => {
    console.log('[worker] connected to master');
  });

  ws.on('message', raw => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === 'welcome') {
      workerId = msg.worker_id;
      console.log(`[worker] registered as ${workerId} (location: ${WORKER_LOCATION})`);
    }

    if (msg.type === 'load') {
      if (activeTest) {
        console.warn(`[worker] already running test ${activeTest}, ignoring new load`);
        return;
      }
      console.log(`[worker] starting test ${msg.test_id} — ${msg.vus} VUs for ${msg.duration_seconds}s`);
      activeTest = msg.test_id;
      runLoad(msg).catch(err => {
        console.error('[worker] runLoad error:', err.message);
        activeTest = null;
      });
    }

    if (msg.type === 'cancel') {
      console.log(`[worker] cancelling test ${msg.test_id}`);
      activeTest = null;
    }
  });

  ws.on('close', () => {
    console.log(`[worker] disconnected, retrying in ${RECONNECT_INTERVAL_MS}ms`);
    ws = null;
    activeTest = null;
    setTimeout(connect, RECONNECT_INTERVAL_MS);
  });

  ws.on('error', err => {
    console.error('[worker] ws error:', err.message);
  });
}

connect();
