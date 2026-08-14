import { spawn, type ChildProcess } from 'node:child_process';

/** Generic spawn + health-check-poll + graceful-stop wrapper -- no domain knowledge of
 * which service it's running (that's stack.ts's job). Pipes and line-prefixes the
 * child's stdout/stderr so a failure mid-run is debuggable, rather than silently
 * swallowed. */
export interface ManagedProcessConfig {
  name: string;
  command: string;
  args: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  healthCheckUrl: string;
  healthCheckTimeoutMs?: number;
  healthCheckIntervalMs?: number;
}

export class ManagedProcess {
  private child: ChildProcess | undefined;
  private stopped = false;

  constructor(private readonly config: ManagedProcessConfig) {}

  async start(): Promise<void> {
    const child = spawn(this.config.command, this.config.args, {
      cwd: this.config.cwd,
      env: { ...process.env, ...this.config.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.child = child;

    child.stdout?.on('data', (chunk: Buffer) => process.stdout.write(prefixLines(this.config.name, chunk)));
    child.stderr?.on('data', (chunk: Buffer) => process.stderr.write(prefixLines(this.config.name, chunk)));
    child.on('exit', (code, signal) => {
      if (!this.stopped) {
        console.error(`[${this.config.name}] exited unexpectedly (code=${code}, signal=${signal})`);
      }
    });

    await this.waitForHealthy();
  }

  private async waitForHealthy(): Promise<void> {
    const timeoutMs = this.config.healthCheckTimeoutMs ?? 30_000;
    const intervalMs = this.config.healthCheckIntervalMs ?? 500;
    const deadline = Date.now() + timeoutMs;
    let lastError: unknown;

    while (Date.now() < deadline) {
      if (this.child?.exitCode !== null && this.child?.exitCode !== undefined) {
        throw new Error(`${this.config.name}: process exited (code=${this.child.exitCode}) before becoming healthy`);
      }
      try {
        const res = await fetch(this.config.healthCheckUrl);
        if (res.ok) return;
      } catch (err) {
        lastError = err;
      }
      await delay(intervalMs);
    }
    throw new Error(`${this.config.name}: did not become healthy within ${timeoutMs}ms (last error: ${String(lastError)})`);
  }

  /** Idempotent -- safe to call more than once (e.g. once from normal teardown, once
   * from a SIGINT handler racing it). Windows can't deliver POSIX signals to child
   * processes, so teardown there degrades to Node's default hard-kill behavior for
   * SIGTERM rather than a graceful in-process shutdown handler running -- a documented
   * platform limitation, not silently glossed over. */
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.child?.kill('SIGTERM');
  }
}

function prefixLines(name: string, chunk: Buffer): string {
  const lines = chunk
    .toString()
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => `[${name}] ${line}`);
  return lines.length > 0 ? lines.join('\n') + '\n' : '';
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
