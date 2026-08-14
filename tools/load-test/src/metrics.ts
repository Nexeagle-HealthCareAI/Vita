/** Pure percentile math + report formatting -- no I/O, no process/network knowledge, so
 * it's trivially unit-testable and reusable regardless of how call records were
 * gathered. */

export interface CallRecord {
  callId: string;
  success: boolean;
  error?: string;
  ticketLatencyMs?: number;
  connectLatencyMs?: number;
  sessionReadyLatencyMs?: number;
  turnLatencyMs?: number;
  endToEndLatencyMs?: number;
}

export interface MetricStats {
  count: number;
  min: number;
  mean: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
}

const LATENCY_FIELDS = ['ticketLatencyMs', 'connectLatencyMs', 'sessionReadyLatencyMs', 'turnLatencyMs', 'endToEndLatencyMs'] as const;
type LatencyField = (typeof LATENCY_FIELDS)[number];

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return NaN;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)]!;
}

export function computeStats(values: number[]): MetricStats | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);
  return {
    count: sorted.length,
    min: sorted[0]!,
    mean: sum / sorted.length,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
    max: sorted[sorted.length - 1]!,
  };
}

export interface LoadTestReport {
  totalCalls: number;
  successCount: number;
  failureCount: number;
  wallClockSeconds: number;
  throughputPerSecond: number;
  latencyStats: Partial<Record<LatencyField, MetricStats>>;
  errors: { callId: string; error: string }[];
}

export function buildReport(records: CallRecord[], wallClockSeconds: number): LoadTestReport {
  const successCount = records.filter((r) => r.success).length;
  const failureCount = records.length - successCount;

  const latencyStats: Partial<Record<LatencyField, MetricStats>> = {};
  for (const field of LATENCY_FIELDS) {
    const values = records.map((r) => r[field]).filter((v): v is number => typeof v === 'number');
    const stats = computeStats(values);
    if (stats) latencyStats[field] = stats;
  }

  return {
    totalCalls: records.length,
    successCount,
    failureCount,
    wallClockSeconds,
    throughputPerSecond: wallClockSeconds > 0 ? successCount / wallClockSeconds : 0,
    latencyStats,
    errors: records.filter((r) => !r.success && r.error).map((r) => ({ callId: r.callId, error: r.error! })),
  };
}

function padRight(s: string, width: number): string {
  return s.length >= width ? s : s + ' '.repeat(width - s.length);
}

function fmtMs(n: number): string {
  return `${n.toFixed(0)}ms`;
}

export function formatReport(report: LoadTestReport): string {
  const lines: string[] = [];
  lines.push('=== Load Test Report ===');
  lines.push(`calls: ${report.totalCalls}  success: ${report.successCount}  failed: ${report.failureCount}`);
  lines.push(`wall clock: ${report.wallClockSeconds.toFixed(1)}s  throughput: ${report.throughputPerSecond.toFixed(2)} calls/sec`);
  lines.push('');
  lines.push(padRight('metric', 22) + padRight('min', 8) + padRight('mean', 8) + padRight('p50', 8) + padRight('p95', 8) + padRight('p99', 8) + 'max');
  for (const field of LATENCY_FIELDS) {
    const stats = report.latencyStats[field];
    if (!stats) continue;
    lines.push(
      padRight(field, 22) +
        padRight(fmtMs(stats.min), 8) +
        padRight(fmtMs(stats.mean), 8) +
        padRight(fmtMs(stats.p50), 8) +
        padRight(fmtMs(stats.p95), 8) +
        padRight(fmtMs(stats.p99), 8) +
        fmtMs(stats.max),
    );
  }
  if (report.errors.length > 0) {
    lines.push('');
    lines.push(`errors (${report.errors.length}):`);
    for (const { callId, error } of report.errors.slice(0, 20)) {
      lines.push(`  ${callId}: ${error}`);
    }
    if (report.errors.length > 20) lines.push(`  ... and ${report.errors.length - 20} more`);
  }
  return lines.join('\n');
}
