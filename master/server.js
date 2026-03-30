'use strict';

const express = require('express');
const { WebSocketServer } = require('ws');
const http = require('http');
const https = require('https');
const Database = require('better-sqlite3');
const { randomUUID } = require('crypto');
const path = require('path');
const fs = require('fs');

// ─── Config ──────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 4002;
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'loadtester.db');
const VERIFY_TIMEOUT_MS = 10_000;

// ─── Database ─────────────────────────────────────────────────────────────────
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new Database(DB_PATH);

db.exec(`
  CREATE TABLE IF NOT EXISTS tests (
    id            TEXT PRIMARY KEY,
    target_url    TEXT NOT NULL,
    virtual_users INTEGER NOT NULL,
    duration_sec  INTEGER NOT NULL,
    locations     TEXT NOT NULL,         -- JSON array
    verify_url    TEXT,
    status        TEXT NOT NULL DEFAULT 'pending',
    created_at    INTEGER NOT NULL,
    started_at    INTEGER,
    finished_at   INTEGER,
    error         TEXT
  );

  CREATE TABLE IF NOT EXISTS metrics (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    test_id       TEXT NOT NULL,
    worker_id     TEXT NOT NULL,
    ts            INTEGER NOT NULL,
    rps           REAL,
    latency_avg   REAL,
    latency_p50   REAL,
    latency_p95   REAL,
    latency_p99   REAL,
    errors        INTEGER,
    bytes         INTEGER,
    FOREIGN KEY(test_id) REFERENCES tests(id)
  );

  CREATE TABLE IF NOT EXISTS results (
    test_id       TEXT PRIMARY KEY,
    total_requests INTEGER,
    total_errors   INTEGER,
    rps_avg        REAL,
    rps_peak       REAL,
    latency_p50    REAL,
    latency_p95    REAL,
    latency_p99    REAL,
    throughput_mb  REAL,
    worker_count   INTEGER,
    FOREIGN KEY(test_id) REFERENCES tests(id)
  );
`);

const stmts = {
  insertTest: db.prepare(`INSERT INTO tests (id,target_url,virtual_users,duration_sec,locations,verify_url,status,created_at)
                          VALUES (?,?,?,?,?,?,?,?)`),
  getTest:    db.prepare('SELECT * FROM tests WHERE id=?'),
  listTests:  db.prepare('SELECT * FROM tests ORDER BY created_at DESC LIMIT 100'),
  setStatus:  db.prepare('UPDATE tests SET status=?, started_at=COALESCE(started_at,?), finished_at=?, error=? WHERE id=?'),
  insertMetric: db.prepare(`INSERT INTO metrics (test_id,worker_id,ts,rps,latency_avg,latency_p50,latency_p95,latency_p99,errors,bytes)
                             VALUES (?,?,?,?,?,?,?,?,?,?)`),
  upsertResult: db.prepare(`INSERT OR REPLACE INTO results
                             (test_id,total_requests,total_errors,rps_avg,rps_peak,latency_p50,latency_p95,latency_p99,throughput_mb,worker_count)
                             VALUES (?,?,?,?,?,?,?,?,?,?)`),
  getResult:  db.prepare('SELECT * FROM results WHERE test_id=?'),
  getMetrics: db.prepare('SELECT * FROM metrics WHERE test_id=? ORDER BY ts ASC'),
};

// ─── Active state ─────────────────────────────────────────────────────────────
const connectedWorkers = new Map();   // workerId -> ws
const testWorkers = new Map();        // testId -> Set<workerId>
const testAggregates = new Map();     // testId -> { completed, workers, samples[] }

// ─── Helpers ──────────────────────────────────────────────────────────────────
function httpGet(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, { timeout: timeoutMs }, res => {
      let body = '';
      res.on('data', d => (body += d));
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

async function verifyOwnership(targetUrl, verifyFileUrl) {
  if (!verifyFileUrl) return true; // no verification requested — still blocked below
  try {
    const res = await httpGet(verifyFileUrl, VERIFY_TIMEOUT_MS);
    return res.status === 200;
  } catch {
    return false;
  }
}

function broadcastToWorkers(workerIds, msg) {
  const payload = JSON.stringify(msg);
  for (const wid of workerIds) {
    const ws = connectedWorkers.get(wid);
    if (ws && ws.readyState === 1) ws.send(payload);
  }
}

function cancelTest(testId, reason) {
  const workers = testWorkers.get(testId);
  if (workers) {
    broadcastToWorkers(workers, { type: 'cancel', test_id: testId });
    testWorkers.delete(testId);
  }
  testAggregates.delete(testId);
  stmts.setStatus.run('cancelled', null, Date.now(), reason, testId);
}

function finalizeTest(testId) {
  const agg = testAggregates.get(testId);
  if (!agg) return;

  const samples = agg.samples;
  if (!samples.length) {
    stmts.setStatus.run('finished', null, Date.now(), null, testId);
    testAggregates.delete(testId);
    testWorkers.delete(testId);
    return;
  }

  const totalReqs = samples.reduce((s, m) => s + (m.rps || 0), 0);
  const totalErrors = samples.reduce((s, m) => s + (m.errors || 0), 0);
  const rpsValues = samples.map(m => m.rps || 0);
  const rpsAvg = rpsValues.reduce((a, b) => a + b, 0) / rpsValues.length;
  const rpsPeak = Math.max(...rpsValues);
  const p50s = samples.map(m => m.latency_p50 || 0).filter(Boolean).sort((a,b)=>a-b);
  const p95s = samples.map(m => m.latency_p95 || 0).filter(Boolean).sort((a,b)=>a-b);
  const p99s = samples.map(m => m.latency_p99 || 0).filter(Boolean).sort((a,b)=>a-b);
  const pick = (arr, pct) => arr.length ? arr[Math.floor(arr.length * pct / 100)] : 0;
  const throughput = samples.reduce((s, m) => s + (m.bytes || 0), 0) / 1024 / 1024;

  stmts.upsertResult.run(
    testId, Math.round(totalReqs), totalErrors,
    +rpsAvg.toFixed(2), +rpsPeak.toFixed(2),
    +pick(p50s, 50).toFixed(2), +pick(p95s, 95).toFixed(2), +pick(p99s, 99).toFixed(2),
    +throughput.toFixed(3), agg.workers
  );
  stmts.setStatus.run('finished', null, Date.now(), null, testId);
  testAggregates.delete(testId);
  testWorkers.delete(testId);
}

// ─── Express ──────────────────────────────────────────────────────────────────
const app = express();
app.use(express.json());

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// GET /health
app.get('/health', (req, res) => {
  res.json({
    ok: true,
    workers: connectedWorkers.size,
    active_tests: testWorkers.size,
    ts: Date.now(),
  });
});

// POST /v1/tests
app.post('/v1/tests', async (req, res) => {
  const { target_url, virtual_users, duration_seconds, locations, verification_file_url } = req.body || {};

  if (!target_url) return res.status(400).json({ error: 'target_url required' });
  if (!virtual_users || virtual_users < 1 || virtual_users > 10000)
    return res.status(400).json({ error: 'virtual_users must be 1-10000' });
  if (!duration_seconds || duration_seconds < 10 || duration_seconds > 3600)
    return res.status(400).json({ error: 'duration_seconds must be 10-3600' });
  if (!verification_file_url)
    return res.status(400).json({ error: 'verification_file_url required (anti-DDoS protection)' });

  // Ownership verification
  const verified = await verifyOwnership(target_url, verification_file_url);
  if (!verified) {
    return res.status(403).json({
      error: 'Ownership verification failed',
      hint: `Ensure ${verification_file_url} returns HTTP 200`,
    });
  }

  const available = [...connectedWorkers.keys()];
  if (!available.length)
    return res.status(503).json({ error: 'No workers available' });

  const id = randomUUID();
  const locs = Array.isArray(locations) ? locations : ['default'];

  stmts.insertTest.run(id, target_url, virtual_users, duration_seconds,
    JSON.stringify(locs), verification_file_url, 'pending', Date.now());

  // Assign workers (up to min(available, 5) for this skeleton)
  const assignedWorkers = available.slice(0, Math.min(available.length, 5));
  testWorkers.set(id, new Set(assignedWorkers));
  testAggregates.set(id, { completed: 0, workers: assignedWorkers.length, samples: [] });

  const vuPerWorker = Math.ceil(virtual_users / assignedWorkers.length);
  const rampUp = Math.min(30, Math.floor(duration_seconds * 0.1));

  broadcastToWorkers(assignedWorkers, {
    type: 'load',
    test_id: id,
    target_url,
    vus: vuPerWorker,
    duration_seconds,
    ramp_up_seconds: rampUp,
  });

  stmts.setStatus.run('running', Date.now(), null, null, id);

  res.status(201).json({ id, status: 'running', workers_assigned: assignedWorkers.length });
});

// GET /v1/tests
app.get('/v1/tests', (req, res) => {
  const rows = stmts.listTests.all();
  res.json(rows.map(r => ({ ...r, locations: JSON.parse(r.locations || '[]') })));
});

// GET /v1/tests/:id
app.get('/v1/tests/:id', (req, res) => {
  const test = stmts.getTest.get(req.params.id);
  if (!test) return res.status(404).json({ error: 'Not found' });
  const result = stmts.getResult.get(test.id);
  res.json({
    ...test,
    locations: JSON.parse(test.locations || '[]'),
    results: result || null,
  });
});

// GET /v1/tests/:id/report
app.get('/v1/tests/:id/report', (req, res) => {
  const test = stmts.getTest.get(req.params.id);
  if (!test) return res.status(404).json({ error: 'Not found' });
  const result = stmts.getResult.get(test.id);
  const metrics = stmts.getMetrics.all(test.id);
  res.json({
    report: {
      generated_at: new Date().toISOString(),
      test: { ...test, locations: JSON.parse(test.locations || '[]') },
      summary: result || {},
      timeline: metrics,
    },
  });
});

// DELETE /v1/tests/:id
app.delete('/v1/tests/:id', (req, res) => {
  const test = stmts.getTest.get(req.params.id);
  if (!test) return res.status(404).json({ error: 'Not found' });
  if (test.status !== 'running' && test.status !== 'pending')
    return res.status(409).json({ error: `Test is already ${test.status}` });
  cancelTest(req.params.id, 'cancelled by user');
  res.json({ ok: true, id: req.params.id, status: 'cancelled' });
});

// ─── HTTP + WebSocket server ───────────────────────────────────────────────────
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws, req) => {
  const workerId = randomUUID();
  connectedWorkers.set(workerId, ws);
  console.log(`[master] worker connected: ${workerId} (total: ${connectedWorkers.size})`);

  ws.send(JSON.stringify({ type: 'welcome', worker_id: workerId }));

  ws.on('message', raw => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === 'metrics' && msg.test_id) {
      const agg = testAggregates.get(msg.test_id);
      if (agg) agg.samples.push(msg);
      stmts.insertMetric.run(
        msg.test_id, workerId, msg.timestamp || Date.now(),
        msg.rps || 0, msg.latency_avg || 0,
        msg.latency_p50 || 0, msg.latency_p95 || 0, msg.latency_p99 || 0,
        msg.errors || 0, msg.bytes || 0
      );
    }

    if (msg.type === 'complete' && msg.test_id) {
      const agg = testAggregates.get(msg.test_id);
      if (agg) {
        agg.completed++;
        if (agg.completed >= agg.workers) finalizeTest(msg.test_id);
      }
    }
  });

  ws.on('close', () => {
    connectedWorkers.delete(workerId);
    console.log(`[master] worker disconnected: ${workerId} (total: ${connectedWorkers.size})`);
  });

  ws.on('error', err => {
    console.error(`[master] worker error ${workerId}:`, err.message);
    connectedWorkers.delete(workerId);
  });
});

server.listen(PORT, () => {
  console.log(`[master] LoadTester master listening on :${PORT}`);
  console.log(`[master] DB: ${DB_PATH}`);
});
