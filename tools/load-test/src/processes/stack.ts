import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { platform } from 'node:os';
import type { FastifyInstance } from 'fastify';
import { ManagedProcess } from './managedProcess.js';
import { buildMockVendor } from '../mockVendor.js';
import { checkRedisReachable } from '../redisPreflight.js';

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url)); // tools/load-test/src/processes
const REPO_ROOT = path.resolve(THIS_DIR, '../../../..');

export interface StackPorts {
  gateway: number;
  orchestrator: number;
  audioPreprocess: number;
  mockVendor: number;
}

export interface StackUrls {
  gatewayHttpUrl: string;
  jwtSecret: string;
}

/** Spawns the real local stack (audio-preprocess, orchestrator, gateway as genuinely
 * separate processes -- matching real deployment topology) plus an in-process
 * mock-vendor stub, in dependency order, health-checking each before the next starts.
 * Only Sarvam/Groq are stubbed; everything else is the real, unmodified application
 * code. See tools/load-test/README.md for prerequisites (docker compose up -d redis,
 * pnpm build at the repo root). */
export class Stack {
  private readonly processes: ManagedProcess[] = [];
  private mockVendor: FastifyInstance | undefined;
  private stopped = false;

  constructor(
    private readonly ports: StackPorts,
    private readonly redisUrl: string,
    private readonly jwtSecret: string,
  ) {}

  async start(): Promise<StackUrls> {
    await checkRedisReachable(this.redisUrl);

    this.mockVendor = buildMockVendor();
    await this.mockVendor.listen({ port: this.ports.mockVendor, host: '127.0.0.1' });
    const mockVendorUrl = `http://127.0.0.1:${this.ports.mockVendor}`;

    const audioPreprocess = new ManagedProcess({
      name: 'audio-preprocess',
      command: pythonExecutable(),
      args: ['-m', 'uvicorn', 'app.main:app', '--host', '127.0.0.1', '--port', String(this.ports.audioPreprocess)],
      cwd: path.join(REPO_ROOT, 'apps/audio-preprocess'),
      healthCheckUrl: `http://127.0.0.1:${this.ports.audioPreprocess}/healthz`,
      // Real model loads (Silero VAD + DeepFilterNet) run inside FastAPI's lifespan
      // BEFORE the port accepts connections -- this generous timeout naturally absorbs
      // real cold-load time, no extra synchronization needed.
      healthCheckTimeoutMs: 60_000,
    });
    this.processes.push(audioPreprocess);
    await audioPreprocess.start();

    const orchestrator = new ManagedProcess({
      name: 'orchestrator',
      command: 'node',
      args: ['dist/index.js'],
      cwd: path.join(REPO_ROOT, 'apps/orchestrator'),
      env: {
        ORCHESTRATOR_PORT: String(this.ports.orchestrator),
        REDIS_URL: this.redisUrl,
        GROQ_API_KEY: 'mock',
        GROQ_API_URL: `${mockVendorUrl}/groq/chat/completions`,
        SARVAM_API_KEY: 'mock',
        SARVAM_STT_ENDPOINT: `${mockVendorUrl}/sarvam/stt`,
        SARVAM_TTS_ENDPOINT: `${mockVendorUrl}/sarvam/tts`,
        // Never actually hit -- the mock Groq route always responds with no tool_calls
        // (see mockVendor.ts's doc comment), so HmsClient is never invoked.
        HMS_API_BASE_URL: 'http://127.0.0.1:1',
        HMS_API_KEY: 'mock',
      },
      healthCheckUrl: `http://127.0.0.1:${this.ports.orchestrator}/healthz`,
    });
    this.processes.push(orchestrator);
    await orchestrator.start();

    const gateway = new ManagedProcess({
      name: 'gateway',
      command: 'node',
      args: ['dist/index.js'],
      cwd: path.join(REPO_ROOT, 'apps/gateway'),
      env: {
        GATEWAY_PORT: String(this.ports.gateway),
        ORCHESTRATOR_INTERNAL_URL: `http://127.0.0.1:${this.ports.orchestrator}`,
        AUDIO_PREPROCESS_URL: `http://127.0.0.1:${this.ports.audioPreprocess}`,
        JWT_SIGNING_SECRET: this.jwtSecret,
      },
      healthCheckUrl: `http://127.0.0.1:${this.ports.gateway}/healthz`,
    });
    this.processes.push(gateway);
    await gateway.start();

    return {
      gatewayHttpUrl: `http://127.0.0.1:${this.ports.gateway}`,
      jwtSecret: this.jwtSecret,
    };
  }

  /** Idempotent; reverse startup order (gateway -> orchestrator -> audio-preprocess),
   * then the in-process mock-vendor last. */
  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    for (const proc of [...this.processes].reverse()) {
      proc.stop();
    }
    await this.mockVendor?.close();
  }
}

function pythonExecutable(): string {
  const venvDir = path.join(REPO_ROOT, 'apps/audio-preprocess/.venv');
  return platform() === 'win32' ? path.join(venvDir, 'Scripts', 'python.exe') : path.join(venvDir, 'bin', 'python');
}
