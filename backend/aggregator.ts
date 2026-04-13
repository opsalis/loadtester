/**
 * Aggregator — computes final report summary from in-memory metric points.
 * No database, no persistence. All data is in-memory only.
 */

export interface MetricPoint {
  second: number;
  rps: number;
  p50: number;
  p95: number;
  p99: number;
  errRate: number;
  regions: Record<string, { rps: number; latency: number }>;
}

export interface ReportSummary {
  totalRequests: number;
  avgRps: number;
  peakRps: number;
  avgP50: number;
  avgP95: number;
  avgP99: number;
  errorRate: number;
  duration: number;
  regionBreakdown: Record<string, { avgRps: number; avgLatency: number }>;
}

export function aggregateMetrics(metrics: MetricPoint[], duration: number): ReportSummary {
  if (metrics.length === 0) {
    return { totalRequests: 0, avgRps: 0, peakRps: 0, avgP50: 0, avgP95: 0, avgP99: 0, errorRate: 0, duration, regionBreakdown: {} };
  }

  const totalRequests = metrics.reduce((s, m) => s + m.rps, 0);
  const avgRps = Math.round(totalRequests / metrics.length);
  const peakRps = Math.max(...metrics.map(m => m.rps));
  const avgP50 = Math.round(metrics.reduce((s, m) => s + m.p50, 0) / metrics.length);
  const avgP95 = Math.round(metrics.reduce((s, m) => s + m.p95, 0) / metrics.length);
  const avgP99 = Math.round(metrics.reduce((s, m) => s + m.p99, 0) / metrics.length);
  const errorRate = metrics.reduce((s, m) => s + m.errRate, 0) / metrics.length;

  // Per-region averages
  const regionData: Record<string, { rpsSum: number; latencySum: number; count: number }> = {};
  for (const metric of metrics) {
    for (const [region, data] of Object.entries(metric.regions)) {
      if (!regionData[region]) regionData[region] = { rpsSum: 0, latencySum: 0, count: 0 };
      regionData[region].rpsSum += data.rps;
      regionData[region].latencySum += data.latency;
      regionData[region].count++;
    }
  }

  const regionBreakdown: Record<string, { avgRps: number; avgLatency: number }> = {};
  for (const [region, data] of Object.entries(regionData)) {
    regionBreakdown[region] = {
      avgRps: Math.round(data.rpsSum / data.count),
      avgLatency: Math.round(data.latencySum / data.count)
    };
  }

  return { totalRequests, avgRps, peakRps, avgP50, avgP95, avgP99, errorRate, duration, regionBreakdown };
}
