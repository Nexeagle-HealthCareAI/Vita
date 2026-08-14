import { writeFileSync } from 'node:fs';
import { parseConfig } from './config.js';
import { Stack } from './processes/stack.js';
import { loadFixtureWav, frameify } from './fixtures.js';
import { simulateCall } from './loadClient.js';
import { buildReport, formatReport, type CallRecord } from './metrics.js';

async function main(): Promise<void> {
  const config = parseConfig(process.argv.slice(2));

  console.log(`Load test config: concurrency=${config.concurrency} ramp=${config.ramp} fixture=${config.fixturePhraseId}-${config.fixtureCondition}`);

  let stack: Stack | undefined;
  let gatewayHttpUrl: string;
  let jwtSecret: string;
  let teardownDone = false;

  const teardown = async () => {
    if (teardownDone) return;
    teardownDone = true;
    if (stack) {
      console.log('Tearing down stack...');
      await stack.stop();
    }
  };

  process.on('SIGINT', () => void teardown().then(() => process.exit(1)));
  process.on('SIGTERM', () => void teardown().then(() => process.exit(1)));

  try {
    if (config.skipSpawn) {
      gatewayHttpUrl = config.gatewayHttpUrl!;
      jwtSecret = config.jwtSecret;
      console.log(`--skip-spawn: using already-running stack at ${gatewayHttpUrl}`);
    } else {
      stack = new Stack(
        {
          gateway: config.gatewayPort,
          orchestrator: config.orchestratorPort,
          audioPreprocess: config.audioPreprocessPort,
          mockVendor: config.mockVendorPort,
        },
        config.redisUrl,
        config.jwtSecret,
      );
      console.log('Starting stack (audio-preprocess -> orchestrator -> gateway)...');
      const urls = await stack.start();
      gatewayHttpUrl = urls.gatewayHttpUrl;
      jwtSecret = urls.jwtSecret;
      console.log(`Stack ready at ${gatewayHttpUrl}`);
    }

    const fixtureFile = `${config.fixturePhraseId}-${config.fixtureCondition}.wav`;
    const wav = loadFixtureWav(fixtureFile);
    const frames = frameify(wav.samples);
    console.log(`Loaded fixture ${fixtureFile}: ${frames.length} frames (~${(frames.length * 20) / 1000}s)`);

    const t0 = Date.now();
    const records = await runCalls(config, gatewayHttpUrl, jwtSecret, frames);
    const wallClockSeconds = (Date.now() - t0) / 1000;

    const report = buildReport(records, wallClockSeconds);
    console.log('\n' + formatReport(report));

    if (config.outFile) {
      writeFileSync(config.outFile, JSON.stringify(report, null, 2));
      console.log(`\nWrote ${config.outFile}`);
    }

    await teardown();
    process.exit(report.failureCount > 0 ? 1 : 0);
  } catch (err) {
    console.error('Load test failed:', err instanceof Error ? err.message : err);
    await teardown();
    process.exit(1);
  }
}

async function runCalls(
  config: ReturnType<typeof parseConfig>,
  gatewayHttpUrl: string,
  jwtSecret: string,
  frames: Uint8Array[],
): Promise<CallRecord[]> {
  const calls: Promise<CallRecord>[] = [];
  for (let i = 0; i < config.concurrency; i++) {
    if (config.ramp === 'staggered' && i > 0) {
      await delay(config.rampIntervalMs);
    }
    calls.push(
      simulateCall({
        callId: `call-${i}`,
        gatewayHttpUrl,
        jwtSecret,
        frames,
        holdTimeMs: config.holdTimeMs,
      }),
    );
  }
  return Promise.all(calls);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

void main();
