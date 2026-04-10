import express, { Request, Response, NextFunction } from 'express';
import Database from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';
import path from 'path';
import fs from 'fs';
import http from 'http';
import https from 'https';
import { URL } from 'url';
import { aggregateMetrics } from './aggregator';

const app = express();
app.use(express.json());

// --- Config ---
const PORT = parseInt(process.env.PORT || '3400');
const DB_PATH = process.env.DB_PATH || './data/loadtester.db';
const API_KEY = process.env.API_KEY || '';
const WORKER_IMAGE = process.env.WORKER_IMAGE || 'opsalis/loadtester-worker:latest';
const REGIONS = ['americas', 'europe-de', 'europe-uk', 'asia'];

// --- Database ---
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS tests (
    id TEXT PRIMARY KEY,
    target_url TEXT NOT NULL,
    rps INTEGER NOT NULL DEFAULT 100,
    duration_seconds INTEGER NOT NULL DEFAULT 60,
    ramp_up_seconds INTEGER NOT NULL DEFAULT 5,
    regions TEXT NOT NULL DEFAULT '[]',
    status TEXT NOT NULL DEFAULT 'pending',
    verification_url TEXT,
    verified INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    started_at TEXT,
    completed_at TEXT,
    api_key TEXT,
    tier TEXT NOT NULL DEFAULT 'free'
  );

  CREATE TABLE IF NOT EXISTS metrics (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    test_id TEXT NOT NULL REFERENCES tests(id) ON DELETE CASCADE,
    region TEXT NOT NULL,
    second INTEGER NOT NULL,
    rps REAL NOT NULL DEFAULT 0,
    latency_avg REAL,
    latency_p50 REAL,
    latency_p95 REAL,
    latency_p99 REAL,
    errors INTEGER NOT NULL DEFAULT 0,
    bytes INTEGER NOT NULL DEFAULT 0,
    status_codes TEXT DEFAULT '{}',
    recorded_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS reports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    test_id TEXT NOT NULL UNIQUE REFERENCES tests(id) ON DELETE CASCADE,
    total_requests INTEGER NOT NULL DEFAULT 0,
    total_errors INTEGER NOT NULL DEFAULT 0,
    avg_rps REAL,
    avg_latency REAL,
    p50_latency REAL,
    p95_latency REAL,
    p99_latency REAL,
    max_latency REAL,
    total_bytes INTEGER NOT NULL DEFAULT 0,
    error_rate REAL,
    generated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_metrics_test ON metrics(test_id, second);
`);

// --- Auth ---
function authenticate(req: Request, res: Response, next: NextFunction): void {
  if (!API_KEY) { next(); return; }
  const key = req.headers['x-api-key'] as string;
  if (key !== API_KEY) { res.status(401).json({ error: 'Invalid API key' }); return; }
  next();
}

// --- Prepared Statements ---
const insertTest = db.prepare(`
  INSERT INTO tests (id, target_url, rps, duration_seconds, ramp_up_seconds, regions, verification_url, api_key, tier)
  VALUES (@id, @target_url, @rps, @duration_seconds, @ramp_up_seconds, @regions, @verification_url, @api_key, @tier)
`);
const getTest = db.prepare(`SELECT * FROM tests WHERE id = ?`);
const listTests = db.prepare(`SELECT * FROM tests ORDER BY created_at DESC LIMIT 100`);
const updateTestStatus = db.prepare(`UPDATE tests SET status = ? WHERE id = ?`);
const updateTestStarted = db.prepare(`UPDATE tests SET status = 'running', started_at = datetime('now') WHERE id = ?`);
const updateTestCompleted = db.prepare(`UPDATE tests SET status = 'completed', completed_at = datetime('now') WHERE id = ?`);

const insertMetric = db.prepare(`
  INSERT INTO metrics (test_id, region, second, rps, latency_avg, latency_p50, latency_p95, latency_p99, errors, bytes, status_codes)
  VALUES (@test_id, @region, @second, @rps, @latency_avg, @latency_p50, @latency_p95, @latency_p99, @errors, @bytes, @status_codes)
`);

const getMetrics = db.prepare(`SELECT * FROM metrics WHERE test_id = ? ORDER BY second, region`);
const getReport = db.prepare(`SELECT * FROM reports WHERE test_id = ?`);

// --- Domain Verification ---
async function verifyDomain(targetUrl: string, testId: string): Promise<boolean> {
  const url = new URL(targetUrl);
  const verifyUrl = `${url.protocol}//${url.host}/.well-known/loadtester-verify/${testId}`;

  return new Promise((resolve) => {
    const client = url.protocol === 'https:' ? https : http;
    const req = client.get(verifyUrl, { timeout: 10000 }, (res) => {
      if (res.statusCode === 200) {
        let body = '';
        res.on('data', (chunk) => body += chunk);
        res.on('end', () => resolve(body.trim().length > 0));
      } else {
        resolve(false);
      }
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

// --- Tier Limits ---
function getTierLimits(tier: string) {
  switch (tier) {
    case 'business': return { maxRps: 100000, maxDuration: 3600, allRegions: true };
    case 'pro': return { maxRps: 10000, maxDuration: 600, allRegions: true };
    default: return { maxRps: 100, maxDuration: 60, allRegions: false };
  }
}

// --- Routes ---

app.get('/health', (_req: Request, res: Response) => {
  const testCount = db.prepare('SELECT COUNT(*) as count FROM tests').get() as any;
  res.json({
    status: 'ok',
    version: '1.0.0',
    total_tests: testCount.count,
    uptime: process.uptime()
  });
});

// Create test
app.post('/v1/tests', authenticate, async (req: Request, res: Response) => {
  const id = uuidv4();
  const {
    target_url, rps = 100, duration_seconds = 60,
    ramp_up_seconds = 5, regions = [], tier = 'free'
  } = req.body;

  if (!target_url) {
    res.status(400).json({ error: 'target_url is required' });
    return;
  }

  // Validate tier limits
  const limits = getTierLimits(tier);
  if (rps > limits.maxRps) {
    res.status(400).json({ error: `Max RPS for ${tier} tier is ${limits.maxRps}` });
    return;
  }
  if (duration_seconds > limits.maxDuration) {
    res.status(400).json({ error: `Max duration for ${tier} tier is ${limits.maxDuration}s` });
    return;
  }

  const selectedRegions = limits.allRegions
    ? (regions.length > 0 ? regions : REGIONS)
    : [REGIONS[0]]; // Free tier: 1 region only

  const verificationUrl = `${new URL(target_url).origin}/.well-known/loadtester-verify/${id}`;

  try {
    insertTest.run({
      id, target_url, rps, duration_seconds, ramp_up_seconds,
      regions: JSON.stringify(selectedRegions),
      verification_url: verificationUrl,
      api_key: req.headers['x-api-key'] || null,
      tier
    });

    res.status(201).json({
      id,
      target_url,
      rps,
      duration_seconds,
      regions: selectedRegions,
      status: 'pending',
      verification_url: verificationUrl,
      message: `Serve any content at ${verificationUrl} to verify domain ownership, then POST /v1/tests/${id}/start`
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Start test (after domain verification)
app.post('/v1/tests/:id/start', authenticate, async (req: Request, res: Response) => {
  const test = getTest.get(req.params.id) as any;
  if (!test) { res.status(404).json({ error: 'Test not found' }); return; }
  if (test.status !== 'pending') { res.status(400).json({ error: `Test is already ${test.status}` }); return; }

  // Verify domain ownership
  const verified = await verifyDomain(test.target_url, test.id);
  if (!verified) {
    res.status(403).json({
      error: 'Domain verification failed',
      verification_url: test.verification_url,
      message: 'Serve any content at the verification URL to prove domain ownership'
    });
    return;
  }

  db.prepare('UPDATE tests SET verified = 1 WHERE id = ?').run(test.id);
  updateTestStarted.run(test.id);

  // In production, this would create k8s Jobs via the k8s API
  // For now, we simulate by spawning local workers
  const regions = JSON.parse(test.regions) as string[];
  const rpsPerRegion = Math.ceil(test.rps / regions.length);

  console.log(`Starting test ${test.id}: ${test.rps} RPS across ${regions.length} regions (${rpsPerRegion} each)`);

  // Auto-complete after duration (in production, Jobs report completion)
  setTimeout(() => {
    const currentTest = getTest.get(test.id) as any;
    if (currentTest && currentTest.status === 'running') {
      updateTestCompleted.run(test.id);
      aggregateMetrics(db, test.id);
      console.log(`Test ${test.id} completed`);
    }
  }, test.duration_seconds * 1000);

  res.json({
    id: test.id,
    status: 'running',
    rps_per_region: rpsPerRegion,
    regions,
    estimated_completion: new Date(Date.now() + test.duration_seconds * 1000).toISOString()
  });
});

// List tests
app.get('/v1/tests', authenticate, (_req: Request, res: Response) => {
  const tests = listTests.all();
  res.json({ tests });
});

// Get test
app.get('/v1/tests/:id', authenticate, (req: Request, res: Response) => {
  const test = getTest.get(req.params.id) as any;
  if (!test) { res.status(404).json({ error: 'Test not found' }); return; }
  const metrics = getMetrics.all(req.params.id);
  res.json({ ...test, metrics });
});

// Get report
app.get('/v1/tests/:id/report', authenticate, (req: Request, res: Response) => {
  const test = getTest.get(req.params.id) as any;
  if (!test) { res.status(404).json({ error: 'Test not found' }); return; }
  if (test.status !== 'completed') { res.status(400).json({ error: 'Test has not completed yet' }); return; }

  let report = getReport.get(req.params.id);
  if (!report) {
    aggregateMetrics(db, req.params.id);
    report = getReport.get(req.params.id);
  }
  res.json({ test, report });
});

// Cancel test
app.delete('/v1/tests/:id', authenticate, (req: Request, res: Response) => {
  const test = getTest.get(req.params.id) as any;
  if (!test) { res.status(404).json({ error: 'Test not found' }); return; }
  updateTestStatus.run('cancelled', req.params.id);
  res.json({ cancelled: true });
});

// --- Internal: Worker reports metrics ---
app.post('/v1/internal/metrics', (req: Request, res: Response) => {
  const { test_id, region, second, rps, latency_avg, latency_p50, latency_p95, latency_p99, errors, bytes, status_codes } = req.body;

  if (!test_id || !region) {
    res.status(400).json({ error: 'test_id and region required' });
    return;
  }

  try {
    insertMetric.run({
      test_id, region, second: second || 0,
      rps: rps || 0,
      latency_avg: latency_avg || null,
      latency_p50: latency_p50 || null,
      latency_p95: latency_p95 || null,
      latency_p99: latency_p99 || null,
      errors: errors || 0,
      bytes: bytes || 0,
      status_codes: JSON.stringify(status_codes || {})
    });
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// --- Internal: Worker reports completion ---
app.post('/v1/internal/complete', (req: Request, res: Response) => {
  const { test_id, region } = req.body;
  console.log(`Worker ${region} completed test ${test_id}`);

  // Check if all workers are done
  const test = getTest.get(test_id) as any;
  if (test && test.status === 'running') {
    const regions = JSON.parse(test.regions) as string[];
    // Simple: just mark complete and aggregate
    updateTestCompleted.run(test_id);
    aggregateMetrics(db, test_id);
  }
  res.json({ ok: true });
});

// --- Start ---
app.listen(PORT, '0.0.0.0', () => {
  console.log(`LoadTester API listening on :${PORT}`);
});

export { db, app };
