import { parseArgs } from 'node:util';

/** Single source of truth for CLI args/env -> LoadTestConfig -- no other module reads
 * argv/env directly, matching this codebase's existing convention (see e.g. gateway's
 * index.ts reading env vars only in its own composition root). */
export interface LoadTestConfig {
  concurrency: number;
  ramp: 'all-at-once' | 'staggered';
  rampIntervalMs: number;
  fixturePhraseId: string;
  fixtureCondition: 'clean' | 'snr10' | 'snr0';
  holdTimeMs: number;
  gatewayPort: number;
  orchestratorPort: number;
  audioPreprocessPort: number;
  mockVendorPort: number;
  jwtSecret: string;
  redisUrl: string;
  /** Run only the WS scenario against an already-running stack (started manually or
   * via `pnpm dev`) -- decouples process management from scenario logic, and lets this
   * tool be pointed at a stack you're already iterating on. */
  skipSpawn: boolean;
  gatewayHttpUrl: string | undefined; // required when skipSpawn is true
  outFile: string | undefined;
}

const DEFAULTS = {
  concurrency: 10,
  ramp: 'staggered' as const,
  rampIntervalMs: 200,
  fixturePhraseId: 'book-appointment',
  fixtureCondition: 'clean' as const,
  holdTimeMs: 500,
  gatewayPort: 18080,
  orchestratorPort: 18081,
  audioPreprocessPort: 18090,
  mockVendorPort: 18099,
};

export function parseConfig(argv: string[]): LoadTestConfig {
  const { values } = parseArgs({
    args: argv,
    options: {
      concurrency: { type: 'string' },
      ramp: { type: 'string' },
      'ramp-interval-ms': { type: 'string' },
      fixture: { type: 'string' },
      condition: { type: 'string' },
      'hold-time-ms': { type: 'string' },
      'gateway-port': { type: 'string' },
      'orchestrator-port': { type: 'string' },
      'audio-preprocess-port': { type: 'string' },
      'mock-vendor-port': { type: 'string' },
      'jwt-secret': { type: 'string' },
      'redis-url': { type: 'string' },
      'skip-spawn': { type: 'boolean' },
      'gateway-url': { type: 'string' },
      out: { type: 'string' },
    },
    allowPositionals: false,
  });

  const ramp = values.ramp === 'all-at-once' ? 'all-at-once' : DEFAULTS.ramp;
  const condition = values.condition === 'snr10' || values.condition === 'snr0' ? values.condition : DEFAULTS.fixtureCondition;
  const skipSpawn = values['skip-spawn'] === true;

  if (skipSpawn && !values['gateway-url']) {
    throw new Error('--skip-spawn requires --gateway-url <http://...>');
  }

  return {
    concurrency: intOr(values.concurrency, DEFAULTS.concurrency),
    ramp,
    rampIntervalMs: intOr(values['ramp-interval-ms'], DEFAULTS.rampIntervalMs),
    fixturePhraseId: values.fixture ?? DEFAULTS.fixturePhraseId,
    fixtureCondition: condition,
    holdTimeMs: intOr(values['hold-time-ms'], DEFAULTS.holdTimeMs),
    gatewayPort: intOr(values['gateway-port'], DEFAULTS.gatewayPort),
    orchestratorPort: intOr(values['orchestrator-port'], DEFAULTS.orchestratorPort),
    audioPreprocessPort: intOr(values['audio-preprocess-port'], DEFAULTS.audioPreprocessPort),
    mockVendorPort: intOr(values['mock-vendor-port'], DEFAULTS.mockVendorPort),
    jwtSecret: values['jwt-secret'] ?? process.env.JWT_SIGNING_SECRET ?? 'change-me',
    redisUrl: values['redis-url'] ?? process.env.REDIS_URL ?? 'redis://localhost:6379',
    skipSpawn,
    gatewayHttpUrl: values['gateway-url'],
    outFile: values.out,
  };
}

function intOr(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}
