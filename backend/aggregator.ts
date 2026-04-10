import Database from 'better-sqlite3';

/**
 * Aggregator — computes final test report from per-second per-worker metrics.
 */

export function aggregateMetrics(db: Database.Database, testId: string): void {
  const metrics = db.prepare(`
    SELECT * FROM metrics WHERE test_id = ? ORDER BY second
  `).all(testId) as any[];

  if (metrics.length === 0) {
    console.log(`No metrics found for test ${testId}`);
    return;
  }

  let totalRequests = 0;
  let totalErrors = 0;
  let totalBytes = 0;
  let allLatenciesSum = 0;
  let allLatenciesCount = 0;
  const allP50s: number[] = [];
  const allP95s: number[] = [];
  const allP99s: number[] = [];
  let maxLatency = 0;
  let rpsSum = 0;

  for (const m of metrics) {
    totalRequests += m.rps || 0;
    totalErrors += m.errors || 0;
    totalBytes += m.bytes || 0;
    rpsSum += m.rps || 0;

    if (m.latency_avg != null) {
      allLatenciesSum += m.latency_avg * (m.rps || 1);
      allLatenciesCount += m.rps || 1;
    }
    if (m.latency_p50 != null) allP50s.push(m.latency_p50);
    if (m.latency_p95 != null) allP95s.push(m.latency_p95);
    if (m.latency_p99 != null) {
      allP99s.push(m.latency_p99);
      if (m.latency_p99 > maxLatency) maxLatency = m.latency_p99;
    }
  }

  // Group by second to get unique seconds count
  const seconds = new Set(metrics.map((m: any) => m.second)).size;
  const avgRps = seconds > 0 ? rpsSum / seconds : 0;
  const avgLatency = allLatenciesCount > 0 ? allLatenciesSum / allLatenciesCount : 0;

  // Compute aggregate percentiles (from worker percentiles — approximation)
  allP50s.sort((a, b) => a - b);
  allP95s.sort((a, b) => a - b);
  allP99s.sort((a, b) => a - b);

  const p50 = allP50s.length > 0 ? allP50s[Math.floor(allP50s.length * 0.5)] : 0;
  const p95 = allP95s.length > 0 ? allP95s[Math.floor(allP95s.length * 0.95)] : 0;
  const p99 = allP99s.length > 0 ? allP99s[Math.floor(allP99s.length * 0.99)] : 0;

  const errorRate = totalRequests > 0 ? (totalErrors / totalRequests) * 100 : 0;

  // Upsert report
  db.prepare(`
    INSERT OR REPLACE INTO reports (test_id, total_requests, total_errors, avg_rps, avg_latency, p50_latency, p95_latency, p99_latency, max_latency, total_bytes, error_rate)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    testId, totalRequests, totalErrors,
    Math.round(avgRps * 100) / 100,
    Math.round(avgLatency * 100) / 100,
    Math.round(p50 * 100) / 100,
    Math.round(p95 * 100) / 100,
    Math.round(p99 * 100) / 100,
    maxLatency,
    totalBytes,
    Math.round(errorRate * 100) / 100
  );

  console.log(`Report generated for test ${testId}: ${totalRequests} requests, ${avgRps.toFixed(0)} avg RPS, ${avgLatency.toFixed(1)}ms avg latency, ${errorRate.toFixed(2)}% error rate`);
}
