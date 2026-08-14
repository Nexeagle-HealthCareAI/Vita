import { Redis } from 'ioredis';

/** Orchestrator's own /healthz doesn't check Redis (it's unconditional), so a missing
 * `docker compose up -d redis` would otherwise surface as a confusing downstream
 * timeout once orchestrator is spawned. Checked once, up front, with a clear actionable
 * error instead. */
export async function checkRedisReachable(redisUrl: string): Promise<void> {
  const redis = new Redis(redisUrl, { lazyConnect: true, retryStrategy: () => null });
  try {
    await redis.connect();
    await redis.ping();
  } catch (err) {
    throw new Error(
      `Redis at ${redisUrl} is not reachable (${err instanceof Error ? err.message : String(err)}) -- ` +
        `run \`docker compose up -d redis\` from the repo root first.`,
    );
  } finally {
    redis.disconnect();
  }
}
