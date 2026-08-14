import { describe, expect, it } from 'vitest';
import { buildReport, computeStats, formatReport, type CallRecord } from '../src/metrics.js';

describe('computeStats', () => {
  it('returns null for an empty array', () => {
    expect(computeStats([])).toBeNull();
  });

  it('computes min/mean/percentiles/max against a known distribution', () => {
    const values = Array.from({ length: 100 }, (_, i) => i + 1); // 1..100

    const stats = computeStats(values)!;

    expect(stats.count).toBe(100);
    expect(stats.min).toBe(1);
    expect(stats.max).toBe(100);
    expect(stats.mean).toBeCloseTo(50.5);
    expect(stats.p50).toBe(50);
    expect(stats.p95).toBe(95);
    expect(stats.p99).toBe(99);
  });

  it('is order-independent (sorts internally)', () => {
    const stats = computeStats([5, 1, 4, 2, 3])!;
    expect(stats.min).toBe(1);
    expect(stats.max).toBe(5);
    expect(stats.p50).toBe(3);
  });
});

describe('buildReport', () => {
  function record(overrides: Partial<CallRecord> & { callId: string }): CallRecord {
    return { success: true, ...overrides };
  }

  it('separates success/failure counts and computes throughput', () => {
    const records: CallRecord[] = [
      record({ callId: 'a', success: true, endToEndLatencyMs: 100 }),
      record({ callId: 'b', success: true, endToEndLatencyMs: 200 }),
      record({ callId: 'c', success: false, error: 'timeout' }),
    ];

    const report = buildReport(records, 10);

    expect(report.totalCalls).toBe(3);
    expect(report.successCount).toBe(2);
    expect(report.failureCount).toBe(1);
    expect(report.throughputPerSecond).toBeCloseTo(0.2); // 2 successes / 10s
    expect(report.errors).toEqual([{ callId: 'c', error: 'timeout' }]);
  });

  it('computes latency stats only for fields that have data', () => {
    const records: CallRecord[] = [
      record({ callId: 'a', ticketLatencyMs: 10, connectLatencyMs: 20 }),
      record({ callId: 'b', ticketLatencyMs: 30, connectLatencyMs: 40 }),
    ];

    const report = buildReport(records, 5);

    expect(report.latencyStats.ticketLatencyMs).toBeTruthy();
    expect(report.latencyStats.connectLatencyMs).toBeTruthy();
    expect(report.latencyStats.turnLatencyMs).toBeUndefined();
  });

  it('handles zero wall-clock seconds without dividing by zero', () => {
    const report = buildReport([record({ callId: 'a' })], 0);
    expect(report.throughputPerSecond).toBe(0);
  });
});

describe('formatReport', () => {
  it('produces a readable report containing the key summary line and per-metric stats', () => {
    const records: CallRecord[] = [
      { callId: 'a', success: true, endToEndLatencyMs: 100 },
      { callId: 'b', success: false, error: 'boom' },
    ];
    const report = buildReport(records, 2);

    const text = formatReport(report);

    expect(text).toContain('calls: 2');
    expect(text).toContain('success: 1');
    expect(text).toContain('failed: 1');
    expect(text).toContain('endToEndLatencyMs');
    expect(text).toContain('boom');
  });

  it('caps the printed error list at 20 with a truncation note', () => {
    const records: CallRecord[] = Array.from({ length: 25 }, (_, i) => ({
      callId: `call-${i}`,
      success: false,
      error: 'boom',
    }));
    const report = buildReport(records, 1);

    const text = formatReport(report);

    expect(text).toContain('and 5 more');
  });
});
