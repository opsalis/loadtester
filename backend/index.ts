/**
 * LoadTester API Backend
 * Zero-storage, one-shot load testing service
 * All data is in-memory only — nothing is persisted after the session
 */
import express, { Request, Response } from 'express';
import crypto from 'crypto';
import http from 'http';
import https from 'https';
import { URL } from 'url';
import { EventEmitter } from 'events';

const app = express();
app.use(express.json({ limit: '10mb' }));

// ─── Config ───────────────────────────────────────────────────────────────────
const PORT = parseInt(process.env.PORT || '3400');
const SCENARIO_ENCRYPTION_KEY = process.env.SCENARIO_ENCRYPTION_KEY
  || crypto.randomBytes(32).toString('hex'); // generate per-boot key if not set

if (!process.env.SCENARIO_ENCRYPTION_KEY) {
  console.warn('[WARN] SCENARIO_ENCRYPTION_KEY not set — .loadtest files from this boot will not be usable after restart.');
}

const REGIONS = ['americas', 'europe-de', 'europe-uk', 'asia'];

// ─── In-memory state (purged on session end) ──────────────────────────────────
interface TestSession {
  id: string;
  mode: 'simple' | 'scenario';
  status: 'pending' | 'running' | 'done' | 'error';
  config: any;
  startedAt?: number;
  completedAt?: number;
  metrics: MetricPoint[];
  emitter: EventEmitter;
  timer?: ReturnType<typeof setInterval>;
}

interface MetricPoint {
  second: number;
  rps: number;
  p50: number;
  p95: number;
  p99: number;
  errRate: number;
  regions: Record<string, { rps: number; latency: number }>;
}

interface RecordSession {
  id: string;
  url: string;
  steps: Array<{ type: string; label: string; [key: string]: any }>;
  startedAt: number;
}

const tests = new Map<string, TestSession>();
const recordings = new Map<string, RecordSession>();

// Auto-purge sessions after 2 hours
function scheduleSessionPurge(id: string) {
  setTimeout(() => {
    const session = tests.get(id);
    if (session) {
      if (session.timer) clearInterval(session.timer);
      session.emitter.removeAllListeners();
      tests.delete(id);
    }
  }, 2 * 60 * 60 * 1000);
}

// ─── CORS ────────────────────────────────────────────────────────────────────
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,X-LoadTester-Key');
  if (req.method === 'OPTIONS') { res.sendStatus(204); return; }
  next();
});

// ─── Scenario encryption ──────────────────────────────────────────────────────
function encryptScenario(payload: any): Buffer {
  const key = Buffer.from(SCENARIO_ENCRYPTION_KEY, 'hex');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const data = JSON.stringify({ version: 1, created: Date.now(), ...payload });
  const ct = Buffer.concat([cipher.update(data, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ct]);
}

function decryptScenario(buf: Buffer): any {
  const key = Buffer.from(SCENARIO_ENCRYPTION_KEY, 'hex');
  const iv = buf.slice(0, 12);
  const tag = buf.slice(12, 28);
  const ct = buf.slice(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const plain = Buffer.concat([decipher.update(ct), decipher.final()]);
  return JSON.parse(plain.toString('utf8'));
}

// ─── Domain verification ──────────────────────────────────────────────────────
async function fetchVerifyFile(verifyUrl: string): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      const parsed = new URL(verifyUrl);
      const client = parsed.protocol === 'https:' ? https : http;
      const req = client.get(verifyUrl, { timeout: 8000 }, (res) => {
        if (res.statusCode !== 200) { resolve(null); return; }
        let body = '';
        res.on('data', chunk => body += chunk);
        res.on('end', () => resolve(body.trim()));
      });
      req.on('error', () => resolve(null));
      req.on('timeout', () => { req.destroy(); resolve(null); });
    } catch {
      resolve(null);
    }
  });
}

// ─── Load simulation engine ───────────────────────────────────────────────────
function startSimpleTest(session: TestSession) {
  const { rps, duration, regions: selectedRegions } = session.config;
  const regionList: string[] = selectedRegions || ['americas'];
  let second = 0;

  session.timer = setInterval(() => {
    if (second >= duration) {
      clearInterval(session.timer!);
      session.status = 'done';
      session.completedAt = Date.now();
      const point: MetricPoint & { done: true } = { ...buildMetric(second, rps, regionList), done: true };
      session.emitter.emit('metric', point);
      // Purge after 30s post-completion
      setTimeout(() => {
        session.emitter.removeAllListeners();
        tests.delete(session.id);
      }, 30_000);
      return;
    }

    const metric = buildMetric(second, rps, regionList);
    session.metrics.push(metric);
    session.emitter.emit('metric', { ...metric, elapsed: second, duration });
    second++;
  }, 1000);
}

function startScenarioTest(session: TestSession) {
  const { users, duration, regions: selectedRegions } = session.config;
  const regionList: string[] = selectedRegions || ['americas'];
  let second = 0;
  const iterationsPerSec = Math.max(1, Math.floor(users / 10));

  session.timer = setInterval(() => {
    if (second >= duration) {
      clearInterval(session.timer!);
      session.status = 'done';
      session.completedAt = Date.now();
      session.emitter.emit('metric', { done: true });
      setTimeout(() => {
        session.emitter.removeAllListeners();
        tests.delete(session.id);
      }, 30_000);
      return;
    }

    const metric = buildMetric(second, iterationsPerSec, regionList, true);
    session.metrics.push(metric);
    session.emitter.emit('metric', { ...metric, elapsed: second, duration });
    second++;
  }, 1000);
}

function buildMetric(second: number, targetRps: number, regionList: string[], browserMode = false): MetricPoint {
  // Simulate realistic load curve with variance
  const warmup = Math.min(1, second / 5);
  const baseRps = Math.round(targetRps * warmup * (0.92 + Math.random() * 0.16));
  const baseLatency = browserMode ? 800 + Math.random() * 400 : 45 + Math.random() * 30;
  const errRate = Math.random() * (second > 3 ? 0.015 : 0.001);

  const regionMetrics: Record<string, { rps: number; latency: number }> = {};
  const perRegionRps = Math.floor(baseRps / regionList.length);
  const latencyOffsets: Record<string, number> = {
    'americas': 0, 'europe-de': 18, 'europe-uk': 23, 'asia': 52
  };

  for (const region of regionList) {
    regionMetrics[region] = {
      rps: perRegionRps + Math.round((Math.random() - 0.5) * perRegionRps * 0.1),
      latency: Math.round(baseLatency + (latencyOffsets[region] || 0) + (Math.random() - 0.5) * 10)
    };
  }

  return {
    second,
    rps: baseRps,
    p50: Math.round(baseLatency),
    p95: Math.round(baseLatency * 2.8),
    p99: Math.round(baseLatency * 4.5),
    errRate,
    regions: regionMetrics
  };
}

// ─── API Routes ───────────────────────────────────────────────────────────────

// Health
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', version: '2.0.0', activeSessions: tests.size });
});

// POST /api/create-scenario — encrypt scenario steps → .loadtest download
app.post('/api/create-scenario', (req: Request, res: Response) => {
  try {
    const { type, steps, script, name } = req.body;
    if (!type) { res.status(400).json({ error: 'type is required' }); return; }

    const payload = { type, name: name || 'scenario', steps, script };
    const encrypted = encryptScenario(payload);

    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${(name || 'scenario').replace(/[^a-z0-9-_]/gi, '-')}.loadtest"`);
    res.send(encrypted);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/record-start — start a browser recording session
app.post('/api/record-start', (req: Request, res: Response) => {
  const { url } = req.body;
  if (!url) { res.status(400).json({ error: 'url is required' }); return; }

  const sessionId = 'rec_' + crypto.randomBytes(8).toString('hex');
  const session: RecordSession = {
    id: sessionId,
    url,
    steps: [{ type: 'navigate', label: `navigate("${url}")`, url }],
    startedAt: Date.now()
  };
  recordings.set(sessionId, session);

  // Auto-purge recording after 30 minutes
  setTimeout(() => recordings.delete(sessionId), 30 * 60 * 1000);

  res.json({
    sessionId,
    recordUrl: url, // In production: open in Playwright with codegen enabled
    message: 'Recording session started. Open your browser and interact with the site.'
  });
});

// GET /api/record-steps/:sessionId — poll for captured steps
app.get('/api/record-steps/:sessionId', (req: Request, res: Response) => {
  const session = recordings.get(req.params.sessionId);
  if (!session) { res.status(404).json({ error: 'Recording session not found' }); return; }
  res.json({ steps: session.steps, count: session.steps.length });
});

// POST /api/record-stop/:sessionId — stop recording
app.post('/api/record-stop/:sessionId', (req: Request, res: Response) => {
  const session = recordings.get(req.params.sessionId);
  if (!session) { res.status(404).json({ error: 'Recording session not found' }); return; }
  const steps = session.steps;
  recordings.delete(req.params.sessionId);
  res.json({ steps, count: steps.length });
});

// POST /api/verify-domain — check domain verification file
app.post('/api/verify-domain', async (req: Request, res: Response) => {
  const { testId, verifyUrl } = req.body;
  if (!testId || !verifyUrl) {
    res.status(400).json({ error: 'testId and verifyUrl are required' });
    return;
  }

  const content = await fetchVerifyFile(verifyUrl);
  if (!content) {
    res.status(400).json({ ok: false, error: 'Verification file not found or not accessible at ' + verifyUrl });
    return;
  }

  // Content must contain the testId
  if (!content.includes(testId)) {
    res.status(400).json({ ok: false, error: 'Verification file content does not match expected token' });
    return;
  }

  res.json({ ok: true, testId, message: 'Domain verified successfully' });
});

// POST /api/simple-test — start a simple HTTP load test
app.post('/api/simple-test', (req: Request, res: Response) => {
  const { url, rps = 100, duration = 60, regions = ['americas'], testId } = req.body;
  if (!url) { res.status(400).json({ error: 'url is required' }); return; }

  // Validate tier
  const validRps = [100, 10000, 100000];
  const validDur = [60, 600, 3600];
  const safeRps = validRps.includes(rps) ? rps : 100;
  const safeDur = validDur.includes(duration) ? duration : 60;

  const id = testId || ('lt_' + crypto.randomBytes(6).toString('hex'));

  const session: TestSession = {
    id,
    mode: 'simple',
    status: 'running',
    config: { url, rps: safeRps, duration: safeDur, regions },
    startedAt: Date.now(),
    metrics: [],
    emitter: new EventEmitter()
  };
  session.emitter.setMaxListeners(50);
  tests.set(id, session);
  scheduleSessionPurge(id);

  // Start simulation (in production: dispatch to regional worker fleet)
  startSimpleTest(session);

  res.json({ id, status: 'running', streamUrl: `/api/test/${id}/stream` });
});

// POST /api/scenario-test — start a scenario test
app.post('/api/scenario-test', (req: Request, res: Response) => {
  const { users = 5, duration = 60, regions = ['americas'], testId, scenarios } = req.body;

  const validUsers = [5, 100, 500];
  const validDur = [60, 600, 3600];
  const safeUsers = validUsers.includes(users) ? users : 5;
  const safeDur = validDur.includes(duration) ? duration : 60;

  const id = testId || ('lt_' + crypto.randomBytes(6).toString('hex'));

  const session: TestSession = {
    id,
    mode: 'scenario',
    status: 'running',
    config: { users: safeUsers, duration: safeDur, regions, scenarios },
    startedAt: Date.now(),
    metrics: [],
    emitter: new EventEmitter()
  };
  session.emitter.setMaxListeners(50);
  tests.set(id, session);
  scheduleSessionPurge(id);

  startScenarioTest(session);

  res.json({ id, status: 'running', streamUrl: `/api/test/${id}/stream` });
});

// GET /api/test/:id/stream — SSE stream of live metrics
app.get('/api/test/:id/stream', (req: Request, res: Response) => {
  const session = tests.get(req.params.id);
  if (!session) {
    res.status(404).json({ error: 'Test session not found' });
    return;
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  // Send any buffered metrics
  for (const m of session.metrics) {
    res.write(`data: ${JSON.stringify({ ...m, elapsed: m.second, duration: session.config.duration })}\n\n`);
  }

  // If already done
  if (session.status === 'done') {
    res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
    res.end();
    return;
  }

  const onMetric = (data: any) => {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
    if (data.done) {
      res.end();
      session.emitter.off('metric', onMetric);
    }
  };

  session.emitter.on('metric', onMetric);

  req.on('close', () => {
    session.emitter.off('metric', onMetric);
  });
});

// GET /api/test/:id/report — download PDF report
app.get('/api/test/:id/report', (req: Request, res: Response) => {
  const session = tests.get(req.params.id);
  if (!session) {
    res.status(404).json({ error: 'Test session not found or already expired' });
    return;
  }

  if (session.status !== 'done') {
    res.status(409).json({ error: 'Test is still running' });
    return;
  }

  // Generate a simple text-based "report" — in production this would be a real PDF
  const metrics = session.metrics;
  const avgRps = metrics.length ? Math.round(metrics.reduce((s, m) => s + m.rps, 0) / metrics.length) : 0;
  const avgP50 = metrics.length ? Math.round(metrics.reduce((s, m) => s + m.p50, 0) / metrics.length) : 0;
  const avgP95 = metrics.length ? Math.round(metrics.reduce((s, m) => s + m.p95, 0) / metrics.length) : 0;
  const avgP99 = metrics.length ? Math.round(metrics.reduce((s, m) => s + m.p99, 0) / metrics.length) : 0;
  const avgErrRate = metrics.length ? (metrics.reduce((s, m) => s + m.errRate, 0) / metrics.length * 100).toFixed(2) : '0';
  const duration = session.config.duration;
  const totalRequests = metrics.reduce((s, m) => s + m.rps, 0);

  const reportText = [
    '='.repeat(60),
    `LOADTESTER REPORT`,
    `Test ID: ${session.id}`,
    `Mode: ${session.mode === 'simple' ? 'Quick Load Test' : 'Scenario Test'}`,
    `Date: ${new Date().toISOString()}`,
    '='.repeat(60),
    '',
    'CONFIGURATION',
    '-'.repeat(40),
    session.mode === 'simple'
      ? `Target URL: ${session.config.url}\nRPS: ${session.config.rps}\nDuration: ${duration}s`
      : `Virtual Users: ${session.config.users}\nDuration: ${duration}s`,
    `Regions: ${(session.config.regions || ['americas']).join(', ')}`,
    '',
    'RESULTS SUMMARY',
    '-'.repeat(40),
    `Total Requests: ${totalRequests.toLocaleString()}`,
    `Average RPS: ${avgRps.toLocaleString()}`,
    `Error Rate: ${avgErrRate}%`,
    '',
    'LATENCY PERCENTILES (avg over test)',
    '-'.repeat(40),
    `P50 (median): ${avgP50}ms`,
    `P95: ${avgP95}ms`,
    `P99: ${avgP99}ms`,
    '',
    'PER-REGION BREAKDOWN',
    '-'.repeat(40),
    ...Object.entries(metrics[metrics.length - 1]?.regions || {}).map(([region, data]: [string, any]) =>
      `${region}: ${data.rps} RPS, ${data.latency}ms avg latency`
    ),
    '',
    '='.repeat(60),
    'Data deleted from LoadTester servers. This report is your only record.',
    '='.repeat(60),
  ].join('\n');

  // Purge session now that report is delivered
  setTimeout(() => {
    if (session.timer) clearInterval(session.timer);
    session.emitter.removeAllListeners();
    tests.delete(session.id);
  }, 5000);

  // In production, generate a real PDF here using pdfkit or similar
  // For now, send as text/plain
  res.setHeader('Content-Type', 'text/plain');
  res.setHeader('Content-Disposition', `attachment; filename="loadtest-report-${session.id}.txt"`);
  res.send(reportText);
});

// ─── Start server ─────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`[LoadTester API] Listening on :${PORT}`);
  console.log(`[LoadTester API] Scenario encryption key fingerprint: ${SCENARIO_ENCRYPTION_KEY.slice(0, 8)}...`);
  console.log(`[LoadTester API] Zero-storage mode: all data in-memory only`);
});

export default app;
