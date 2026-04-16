/**
 * LoadTester API Backend — production build (2026-04-16)
 *
 * Responsibilities:
 *  1. Domain-ownership verification (anti-DDoS) — REQUIRED before any test can run.
 *  2. Payment verification via OpsalisBilling on-chain Paid events.
 *  3. Dispatch real k8s Jobs (per region) that hit the target and stream metrics back.
 *  4. Aggregate per-worker metrics → SSE stream + final report.
 *  5. Rate-limit free tier to 5 tests per source IP per day.
 *
 * Payment contract: `OpsalisBilling` on Sertone Demo L2 (chainId 845312).
 * See ../contracts/OpsalisBilling.deployment.json for address + abi.
 */
import express, { Request, Response } from 'express';
import crypto from 'crypto';
import http from 'http';
import https from 'https';
import fs from 'fs';
import path from 'path';
import { URL } from 'url';
import { EventEmitter } from 'events';
import Database from 'better-sqlite3';
import { ethers } from 'ethers';
import * as k8s from '@kubernetes/client-node';

const app = express();
app.set('trust proxy', true);
app.use(express.json({ limit: '10mb' }));

// ─── Config ───────────────────────────────────────────────────────────────────
const PORT = parseInt(process.env.PORT || '3400');
const SCENARIO_ENCRYPTION_KEY = process.env.SCENARIO_ENCRYPTION_KEY
  || crypto.randomBytes(32).toString('hex');
const DB_PATH = process.env.DB_PATH || '/app/data/loadtester.db';
const NAMESPACE = process.env.NAMESPACE || 'loadtester';
const WORKER_IMAGE = process.env.WORKER_IMAGE || 'sertonenet/loadtester-worker:latest';
const BILLING_RPC = process.env.BILLING_RPC || 'http://l2-rpc.opsalis-l2-demo.svc.cluster.local:8545';

// Load canonical billing deployment artifact
const deploymentPath = path.join(__dirname, '..', 'contracts', 'OpsalisBilling.deployment.json');
let deployment: any;
try {
  deployment = JSON.parse(fs.readFileSync(deploymentPath, 'utf8'));
} catch (e) {
  // Fallback — hardcoded canonical addresses
  deployment = {
    address: '0xCEfD64724E6EAbD3372188d3b558b1e74dD27Bc6',
    loadtester: { serviceId: '0x39e319d50c7360338f5104d5ff8f943e6a8aa90173b926382f58b02d99673538' },
    productIds: {
      free:     '0x8e44197ab27d270387332c02e9d19e504509374a270fc65c9c74f3ee10e03e18',
      pro:      '0x3b61c0fe064f998f32a3661de12f8ef66f69d3eed20df1d23c30fc57463ab9b2',
      business: '0x4639789e15ff748c2ee5ad3e8ae97408e1bb54671ffe37777e5aefe1a8715a28'
    },
    tierPrices: { free: '0', pro: '20000000', business: '100000000' }
  };
}
const BILLING_ADDRESS: string = deployment.address;
const LOADTESTER_SERVICE_ID: string = deployment.loadtester.serviceId;
const PRODUCT_IDS: Record<string,string> = deployment.productIds;
const TIER_PRICES_ATOMIC: Record<string,bigint> = {
  free:     BigInt(deployment.tierPrices?.free     ?? '0'),
  pro:      BigInt(deployment.tierPrices?.pro      ?? '20000000'),
  business: BigInt(deployment.tierPrices?.business ?? '100000000'),
};

// Paid event topic = keccak256("Paid(bytes32,bytes32,address,uint256,uint256)")
const PAID_EVENT_TOPIC = ethers.id('Paid(bytes32,bytes32,address,uint256,uint256)');

// Region label mapping: frontend region → k8s nodeSelector value
// Nodes are labelled topology.kubernetes.io/region = am | eu | as | sa
const REGION_TO_K8S: Record<string, string> = {
  'americas':   'am',
  'europe-de':  'eu',
  'europe-uk':  'eu',
  'asia':       'as'
};
const DEFAULT_REGIONS = ['americas'];

// ─── SQLite init ──────────────────────────────────────────────────────────────
try { fs.mkdirSync(path.dirname(DB_PATH), { recursive: true }); } catch {}
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS paid_txs (
    tx_hash TEXT PRIMARY KEY,
    service_id TEXT NOT NULL,
    product_id TEXT NOT NULL,
    customer TEXT NOT NULL,
    amount TEXT NOT NULL,
    test_id TEXT,
    consumed_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS free_tier_uses (
    ip TEXT NOT NULL,
    day TEXT NOT NULL,
    count INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (ip, day)
  );
  CREATE TABLE IF NOT EXISTS verified_domains (
    test_id TEXT PRIMARY KEY,
    domain TEXT NOT NULL,
    verified_at INTEGER NOT NULL
  );
`);
const insertPaid = db.prepare('INSERT INTO paid_txs (tx_hash, service_id, product_id, customer, amount, test_id, consumed_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
const findPaid = db.prepare('SELECT * FROM paid_txs WHERE tx_hash = ?');
const getFreeCount = db.prepare('SELECT count FROM free_tier_uses WHERE ip = ? AND day = ?');
const upsertFreeCount = db.prepare('INSERT INTO free_tier_uses (ip, day, count) VALUES (?, ?, 1) ON CONFLICT(ip, day) DO UPDATE SET count = count + 1');
const markVerified = db.prepare('INSERT OR REPLACE INTO verified_domains (test_id, domain, verified_at) VALUES (?, ?, ?)');
const getVerified = db.prepare('SELECT * FROM verified_domains WHERE test_id = ?');

// ─── In-memory test state ─────────────────────────────────────────────────────
interface TestSession {
  id: string;
  mode: 'simple' | 'scenario';
  status: 'pending' | 'running' | 'done' | 'error';
  config: any;
  startedAt?: number;
  completedAt?: number;
  metrics: MetricPoint[];
  workerMetrics: Map<string, Map<number, WorkerSecond>>; // region → second → data
  workerDone: Set<string>;
  expectedWorkers: Set<string>;
  emitter: EventEmitter;
  tier: string;
  jobNames: string[];
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
interface WorkerSecond {
  rps: number;
  latency_p50: number;
  latency_p95: number;
  latency_p99: number;
  latency_avg: number;
  errors: number;
}
const tests = new Map<string, TestSession>();

// ─── K8s client ───────────────────────────────────────────────────────────────
const kc = new k8s.KubeConfig();
try { kc.loadFromCluster(); } catch (e) {
  try { kc.loadFromDefault(); } catch {}
}
const batchApi = kc.makeApiClient(k8s.BatchV1Api);

// ─── CORS ─────────────────────────────────────────────────────────────────────
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

// ─── Domain verification ──────────────────────────────────────────────────────
function buildVerifyUrl(targetUrl: string, testId: string): string {
  const u = new URL(targetUrl);
  return `${u.protocol}//${u.host}/.well-known/loadtester-verify/${testId}`;
}

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

async function verifyDomainOwnership(testId: string, targetUrl: string): Promise<{ ok: boolean; error?: string }> {
  const verifyUrl = buildVerifyUrl(targetUrl, testId);
  const content = await fetchVerifyFile(verifyUrl);
  if (!content) return { ok: false, error: `Verification file not accessible at ${verifyUrl}` };
  if (!content.includes(testId)) return { ok: false, error: 'Verification file content does not include testId' };
  const u = new URL(targetUrl);
  markVerified.run(testId, u.host, Date.now());
  return { ok: true };
}

// ─── Payment verification ─────────────────────────────────────────────────────
let billingProvider: ethers.JsonRpcProvider | null = null;
function getProvider(): ethers.JsonRpcProvider {
  if (!billingProvider) billingProvider = new ethers.JsonRpcProvider(BILLING_RPC);
  return billingProvider;
}

async function verifyPayment(txHash: string, tier: string, claimedWallet: string): Promise<{ ok: boolean; error?: string }> {
  if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) return { ok: false, error: 'Invalid txHash format' };
  // Replay protection: this txHash already consumed?
  if (findPaid.get(txHash)) return { ok: false, error: 'Payment tx already consumed' };

  const expectedProductId = PRODUCT_IDS[tier];
  const requiredAmount = TIER_PRICES_ATOMIC[tier];
  if (!expectedProductId || requiredAmount == null) return { ok: false, error: `Unknown tier: ${tier}` };

  let receipt: ethers.TransactionReceipt | null = null;
  try {
    receipt = await getProvider().getTransactionReceipt(txHash);
  } catch (e: any) {
    return { ok: false, error: `RPC error: ${e.message}` };
  }
  if (!receipt) return { ok: false, error: 'Tx not mined yet' };
  if (receipt.status !== 1) return { ok: false, error: 'Tx reverted' };
  if (receipt.to?.toLowerCase() !== BILLING_ADDRESS.toLowerCase()) {
    return { ok: false, error: `Tx target is not billing contract (${receipt.to})` };
  }

  // Find Paid event: topic0 = PAID_EVENT_TOPIC, topic1 = serviceId, topic2 = productId, topic3 = customer
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== BILLING_ADDRESS.toLowerCase()) continue;
    if (log.topics[0] !== PAID_EVENT_TOPIC) continue;
    const evServiceId = log.topics[1];
    const evProductId = log.topics[2];
    const evCustomerTopic = log.topics[3];
    // customer is 20-byte address left-padded into a 32-byte topic
    const evCustomer = '0x' + evCustomerTopic.slice(-40);
    if (evServiceId.toLowerCase() !== LOADTESTER_SERVICE_ID.toLowerCase()) continue;
    if (evProductId.toLowerCase() !== expectedProductId.toLowerCase()) continue;
    if (evCustomer.toLowerCase() !== claimedWallet.toLowerCase()) continue;
    // data = abi.encode(amount, timestamp) — 64 hex chars each
    const dataHex = log.data.startsWith('0x') ? log.data.slice(2) : log.data;
    const amount = BigInt('0x' + dataHex.slice(0, 64));
    if (amount < requiredAmount) {
      return { ok: false, error: `Amount ${amount} < required ${requiredAmount}` };
    }
    // All good — record
    try {
      insertPaid.run(txHash, evServiceId, evProductId, evCustomer, amount.toString(), null, Date.now());
    } catch (e) {
      // UNIQUE conflict — race, treat as already consumed
      return { ok: false, error: 'Payment tx already consumed (race)' };
    }
    return { ok: true };
  }
  return { ok: false, error: 'No matching Paid event found in tx logs' };
}

// ─── Rate limiting ────────────────────────────────────────────────────────────
function todayKey() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}
function checkFreeTierQuota(ip: string): { ok: boolean; remaining: number } {
  const day = todayKey();
  const row: any = getFreeCount.get(ip, day);
  const count = row?.count || 0;
  if (count >= 5) return { ok: false, remaining: 0 };
  return { ok: true, remaining: 5 - count };
}
function incFreeTierQuota(ip: string) {
  upsertFreeCount.run(ip, todayKey());
}

// ─── K8s Job dispatch ─────────────────────────────────────────────────────────
async function spawnWorkerJob(opts: {
  testId: string;
  region: string;      // frontend region name
  k8sRegion: string;   // am|eu|as|sa
  targetUrl: string;
  rps: number;
  duration: number;
}): Promise<string> {
  // k8s Job names must match RFC1123 (lowercase alphanumeric + dashes only)
  const safeTestId = opts.testId.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  const safeRegion = opts.region.toLowerCase().replace(/[^a-z0-9]/g, '-');
  const jobName = `lt-${safeTestId}-${safeRegion}`.slice(0, 60).replace(/-$/, '');
  const body: k8s.V1Job = {
    apiVersion: 'batch/v1',
    kind: 'Job',
    metadata: {
      name: jobName,
      namespace: NAMESPACE,
      labels: {
        app: 'loadtester',
        component: 'worker',
        'test-id': opts.testId,
        region: opts.region
      }
    },
    spec: {
      ttlSecondsAfterFinished: 60,
      backoffLimit: 0,
      activeDeadlineSeconds: Math.max(opts.duration + 60, 120),
      template: {
        metadata: {
          labels: {
            app: 'loadtester',
            component: 'worker',
            'test-id': opts.testId
          }
        },
        spec: {
          nodeSelector: { 'topology.kubernetes.io/region': opts.k8sRegion },
          restartPolicy: 'Never',
          containers: [{
            name: 'worker',
            image: WORKER_IMAGE,
            command: ['node', 'dist/worker.js'],
            env: [
              { name: 'TARGET_URL', value: opts.targetUrl },
              { name: 'RPS', value: String(opts.rps) },
              { name: 'DURATION', value: String(opts.duration) },
              { name: 'RAMP_UP', value: '5' },
              { name: 'REGION', value: opts.region },
              { name: 'TEST_ID', value: opts.testId },
              { name: 'API_URL', value: 'http://loadtester-api.loadtester.svc.cluster.local:3400' }
            ],
            resources: {
              requests: { cpu: '200m', memory: '128Mi' },
              limits:   { cpu: '1000m', memory: '384Mi' }
            }
          }]
        }
      }
    }
  };
  await batchApi.createNamespacedJob({ namespace: NAMESPACE, body });
  return jobName;
}

async function dispatchWorkers(session: TestSession, rps: number, duration: number, regions: string[]): Promise<void> {
  const unique: Record<string,string> = {};
  for (const r of regions) {
    const k = REGION_TO_K8S[r] || 'am';
    if (!unique[r]) unique[r] = k;
  }
  const rpsPerRegion = Math.max(1, Math.floor(rps / Object.keys(unique).length));
  for (const [region, k8sRegion] of Object.entries(unique)) {
    session.expectedWorkers.add(region);
    try {
      const name = await spawnWorkerJob({
        testId: session.id,
        region, k8sRegion,
        targetUrl: session.config.url,
        rps: rpsPerRegion,
        duration
      });
      session.jobNames.push(name);
      console.log(`[dispatch] spawned Job ${name} for test ${session.id} in ${region}/${k8sRegion}`);
    } catch (e: any) {
      console.error(`[dispatch] failed to spawn Job for ${region}:`, e?.body || e?.message || e);
      throw e;
    }
  }
}

// ─── Metrics aggregation ──────────────────────────────────────────────────────
function aggregateSecond(session: TestSession, second: number): MetricPoint {
  const regions: Record<string, { rps: number; latency: number }> = {};
  let totalRps = 0;
  const allLatencies: number[] = [];
  let weightedP50 = 0, weightedP95 = 0, weightedP99 = 0, totalWeight = 0;
  let totalErr = 0, totalReq = 0;

  for (const [region, secondMap] of session.workerMetrics.entries()) {
    const s = secondMap.get(second);
    if (!s) continue;
    totalRps += s.rps;
    regions[region] = { rps: s.rps, latency: Math.round(s.latency_avg) };
    weightedP50 += s.latency_p50 * s.rps;
    weightedP95 += s.latency_p95 * s.rps;
    weightedP99 += s.latency_p99 * s.rps;
    totalWeight += s.rps;
    totalErr += s.errors;
    totalReq += s.rps;
  }
  return {
    second,
    rps: totalRps,
    p50: totalWeight ? Math.round(weightedP50 / totalWeight) : 0,
    p95: totalWeight ? Math.round(weightedP95 / totalWeight) : 0,
    p99: totalWeight ? Math.round(weightedP99 / totalWeight) : 0,
    errRate: totalReq ? totalErr / totalReq : 0,
    regions
  };
}

// ─── Internal endpoints (worker → backend) ───────────────────────────────────
app.post('/v1/internal/metrics', (req: Request, res: Response) => {
  const { test_id, region, second, rps, latency_avg, latency_p50, latency_p95, latency_p99, errors } = req.body;
  const session = tests.get(test_id);
  if (!session) { res.status(404).json({ error: 'test not found' }); return; }
  let secondMap = session.workerMetrics.get(region);
  if (!secondMap) { secondMap = new Map(); session.workerMetrics.set(region, secondMap); }
  secondMap.set(second, {
    rps: rps ?? 0,
    latency_avg: latency_avg ?? 0,
    latency_p50: latency_p50 ?? 0,
    latency_p95: latency_p95 ?? 0,
    latency_p99: latency_p99 ?? 0,
    errors: errors ?? 0
  });
  // Emit aggregated point for this second
  const point = aggregateSecond(session, second);
  session.metrics.push(point);
  session.emitter.emit('metric', { ...point, elapsed: second, duration: session.config.duration });
  res.json({ ok: true });
});

app.post('/v1/internal/complete', (req: Request, res: Response) => {
  const { test_id, region } = req.body;
  const session = tests.get(test_id);
  if (!session) { res.status(404).json({ error: 'test not found' }); return; }
  session.workerDone.add(region);
  console.log(`[complete] worker ${region} finished for ${test_id} (${session.workerDone.size}/${session.expectedWorkers.size})`);
  if (session.workerDone.size >= session.expectedWorkers.size) {
    session.status = 'done';
    session.completedAt = Date.now();
    session.emitter.emit('metric', { done: true });
  }
  res.json({ ok: true });
});

// ─── Public API ───────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', version: '3.0.0', activeSessions: tests.size });
});

// POST /api/verify-domain — publish the verification challenge
app.post('/api/verify-domain', async (req: Request, res: Response) => {
  const { testId, verifyUrl, targetUrl } = req.body;
  if (!testId) { res.status(400).json({ error: 'testId is required' }); return; }
  const urlToCheck = verifyUrl || (targetUrl ? buildVerifyUrl(targetUrl, testId) : null);
  if (!urlToCheck) { res.status(400).json({ error: 'verifyUrl or targetUrl required' }); return; }
  const content = await fetchVerifyFile(urlToCheck);
  if (!content) { res.status(400).json({ ok: false, error: `Verification file not found at ${urlToCheck}` }); return; }
  if (!content.includes(testId)) { res.status(400).json({ ok: false, error: 'Verification file content does not match testId' }); return; }
  let host = '';
  try { host = new URL(urlToCheck).host; } catch {}
  markVerified.run(testId, host, Date.now());
  res.json({ ok: true, testId, message: 'Domain verified' });
});

// POST /api/create-scenario — encrypt scenario steps
app.post('/api/create-scenario', (req: Request, res: Response) => {
  try {
    const { type, steps, script, name } = req.body;
    if (!type) { res.status(400).json({ error: 'type is required' }); return; }
    const encrypted = encryptScenario({ type, name: name || 'scenario', steps, script });
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${(name || 'scenario').replace(/[^a-z0-9-_]/gi, '-')}.loadtest"`);
    res.send(encrypted);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/simple-test — create test (requires: verified domain, payment if paid tier, IP quota if free)
app.post('/api/simple-test', async (req: Request, res: Response) => {
  const { url, rps = 100, duration = 60, regions = ['americas'], testId, tier, txHash, wallet } = req.body;
  if (!url) { res.status(400).json({ error: 'url is required' }); return; }
  if (!testId) { res.status(400).json({ error: 'testId is required' }); return; }

  const validRps = [100, 10000, 100000];
  const validDur = [60, 600, 3600];
  const safeRps = validRps.includes(rps) ? rps : 100;
  const safeDur = validDur.includes(duration) ? duration : 60;
  const regionList: string[] = Array.isArray(regions) && regions.length ? regions : DEFAULT_REGIONS;

  // Tier inference from rps when not supplied
  const resolvedTier: string = tier || (safeRps === 100 ? 'free' : safeRps === 10000 ? 'pro' : 'business');

  // 1. Domain verification MUST have been performed
  const v = getVerified.get(testId) as any;
  if (!v) { res.status(400).json({ error: 'Domain not verified for this testId. Call /api/verify-domain first.' }); return; }
  try {
    const targetHost = new URL(url).host;
    if (v.domain && v.domain !== targetHost) {
      res.status(400).json({ error: `Verified host (${v.domain}) does not match target (${targetHost})` });
      return;
    }
  } catch {
    res.status(400).json({ error: 'Invalid target URL' });
    return;
  }

  // 2. Tier gating
  if (resolvedTier === 'free') {
    const ip = (req.ip || req.socket.remoteAddress || 'unknown').toString();
    const q = checkFreeTierQuota(ip);
    if (!q.ok) { res.status(429).json({ error: 'Free tier daily limit reached (5/day per IP)' }); return; }
    incFreeTierQuota(ip);
  } else {
    if (!txHash || !wallet) { res.status(402).json({ error: 'txHash and wallet required for paid tier' }); return; }
    const p = await verifyPayment(txHash, resolvedTier, wallet);
    if (!p.ok) { res.status(402).json({ error: 'Payment verification failed: ' + p.error }); return; }
  }

  const id = testId;
  const session: TestSession = {
    id,
    mode: 'simple',
    status: 'running',
    config: { url, rps: safeRps, duration: safeDur, regions: regionList },
    startedAt: Date.now(),
    metrics: [],
    workerMetrics: new Map(),
    workerDone: new Set(),
    expectedWorkers: new Set(),
    emitter: new EventEmitter(),
    tier: resolvedTier,
    jobNames: []
  };
  session.emitter.setMaxListeners(50);
  tests.set(id, session);

  try {
    await dispatchWorkers(session, safeRps, safeDur, regionList);
  } catch (e: any) {
    session.status = 'error';
    res.status(500).json({ error: 'Failed to dispatch workers: ' + (e?.message || e) });
    return;
  }

  // Schedule forced cleanup
  setTimeout(() => {
    session.status = 'done';
    session.emitter.emit('metric', { done: true });
  }, (safeDur + 30) * 1000);
  setTimeout(() => {
    session.emitter.removeAllListeners();
    tests.delete(id);
  }, (safeDur + 300) * 1000);

  res.json({ id, status: 'running', streamUrl: `/api/test/${id}/stream`, tier: resolvedTier, regions: regionList });
});

// POST /api/scenario-test — scenario tests also need verification + payment
app.post('/api/scenario-test', async (req: Request, res: Response) => {
  const { testId, users = 5, duration = 60, regions, tier, txHash, wallet, targetUrl } = req.body;
  if (!testId) { res.status(400).json({ error: 'testId is required' }); return; }
  const v = getVerified.get(testId) as any;
  if (!v) { res.status(400).json({ error: 'Domain not verified for this testId' }); return; }
  const resolvedTier: string = tier || (users === 5 ? 'free' : users === 100 ? 'pro' : 'business');

  if (resolvedTier === 'free') {
    const ip = (req.ip || req.socket.remoteAddress || 'unknown').toString();
    const q = checkFreeTierQuota(ip);
    if (!q.ok) { res.status(429).json({ error: 'Free tier daily limit reached' }); return; }
    incFreeTierQuota(ip);
  } else {
    if (!txHash || !wallet) { res.status(402).json({ error: 'txHash and wallet required for paid tier' }); return; }
    const p = await verifyPayment(txHash, resolvedTier, wallet);
    if (!p.ok) { res.status(402).json({ error: 'Payment verification failed: ' + p.error }); return; }
  }
  // For the scenario mode we reuse simple-test's dispatch; scenario executor is out of scope here.
  // We still create a session so the UI can stream progress.
  const url = targetUrl || ('https://' + v.domain);
  const id = testId;
  const session: TestSession = {
    id, mode: 'scenario', status: 'running',
    config: { url, users, duration, regions: regions || ['americas'] },
    startedAt: Date.now(), metrics: [],
    workerMetrics: new Map(), workerDone: new Set(), expectedWorkers: new Set(),
    emitter: new EventEmitter(), tier: resolvedTier, jobNames: []
  };
  session.emitter.setMaxListeners(50);
  tests.set(id, session);
  const rpsEquivalent = Math.max(1, users * 2);
  try {
    await dispatchWorkers(session, rpsEquivalent, duration, regions || ['americas']);
  } catch (e: any) {
    session.status = 'error';
    res.status(500).json({ error: 'Failed to dispatch workers: ' + (e?.message || e) });
    return;
  }
  res.json({ id, status: 'running', streamUrl: `/api/test/${id}/stream`, tier: resolvedTier });
});

// GET /api/test/:id/stream — SSE stream
app.get('/api/test/:id/stream', (req: Request, res: Response) => {
  const session = tests.get(req.params.id as string);
  if (!session) { res.status(404).json({ error: 'Test session not found' }); return; }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  for (const m of session.metrics) {
    res.write(`data: ${JSON.stringify({ ...m, elapsed: m.second, duration: session.config.duration })}\n\n`);
  }
  if (session.status === 'done') {
    res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
    res.end();
    return;
  }
  const onMetric = (data: any) => {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
    if (data.done) { res.end(); session.emitter.off('metric', onMetric); }
  };
  session.emitter.on('metric', onMetric);
  req.on('close', () => { session.emitter.off('metric', onMetric); });
});

// GET /api/test/:id/report
app.get('/api/test/:id/report', (req: Request, res: Response) => {
  const session = tests.get(req.params.id as string);
  if (!session) { res.status(404).json({ error: 'Test session not found or already expired' }); return; }
  if (session.status !== 'done') { res.status(409).json({ error: 'Test is still running' }); return; }

  const metrics = session.metrics;
  const avgRps = metrics.length ? Math.round(metrics.reduce((s, m) => s + m.rps, 0) / metrics.length) : 0;
  const avgP50 = metrics.length ? Math.round(metrics.reduce((s, m) => s + m.p50, 0) / metrics.length) : 0;
  const avgP95 = metrics.length ? Math.round(metrics.reduce((s, m) => s + m.p95, 0) / metrics.length) : 0;
  const avgP99 = metrics.length ? Math.round(metrics.reduce((s, m) => s + m.p99, 0) / metrics.length) : 0;
  const avgErrRate = metrics.length ? (metrics.reduce((s, m) => s + m.errRate, 0) / metrics.length * 100).toFixed(2) : '0';
  const duration = session.config.duration;
  const totalRequests = metrics.reduce((s, m) => s + m.rps, 0);
  const last = metrics[metrics.length - 1]?.regions || {};

  const reportText = [
    '='.repeat(60),
    'LOADTESTER REPORT',
    `Test ID: ${session.id}`,
    `Tier: ${session.tier}`,
    `Mode: ${session.mode}`,
    `Date: ${new Date().toISOString()}`,
    '='.repeat(60),
    '',
    'CONFIGURATION',
    '-'.repeat(40),
    `Target: ${session.config.url}`,
    `Duration: ${duration}s`,
    `Regions: ${(session.config.regions || ['americas']).join(', ')}`,
    `Jobs dispatched: ${session.jobNames.join(', ') || '(none)'}`,
    '',
    'RESULTS SUMMARY',
    '-'.repeat(40),
    `Total Requests: ${totalRequests.toLocaleString()}`,
    `Average RPS: ${avgRps.toLocaleString()}`,
    `Error Rate: ${avgErrRate}%`,
    '',
    'LATENCY PERCENTILES (rps-weighted avg across seconds)',
    '-'.repeat(40),
    `P50: ${avgP50}ms`,
    `P95: ${avgP95}ms`,
    `P99: ${avgP99}ms`,
    '',
    'PER-REGION (final second)',
    '-'.repeat(40),
    ...Object.entries(last).map(([region, data]: [string, any]) => `${region}: ${data.rps} RPS, ${data.latency}ms`),
    '',
    '='.repeat(60),
  ].join('\n');

  setTimeout(() => {
    session.emitter.removeAllListeners();
    tests.delete(session.id);
  }, 5000);

  res.setHeader('Content-Type', 'text/plain');
  res.setHeader('Content-Disposition', `attachment; filename="loadtest-report-${session.id}.txt"`);
  res.send(reportText);
});

// ─── Start server ─────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`[LoadTester API v3.0.0] Listening on :${PORT}`);
  console.log(`[LoadTester API] Billing contract: ${BILLING_ADDRESS}`);
  console.log(`[LoadTester API] serviceId: ${LOADTESTER_SERVICE_ID}`);
  console.log(`[LoadTester API] Billing RPC: ${BILLING_RPC}`);
  console.log(`[LoadTester API] Worker image: ${WORKER_IMAGE}`);
});

export default app;
