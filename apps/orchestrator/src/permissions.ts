import type { HmsClient } from '@vita/mcp-1hms';

/** Resolves a session's real easyHMSAPI permission-key set + hospitalId once, at
 * POST /session composition time -- the source of truth rbac.ts's TOOL_PERMISSIONS checks
 * against, replacing a hand-maintained role enum. Unlike doctorRoster.ts's fetchRosterText
 * (resolved once per PROCESS, off the request path), this sits on a live caller's call-setup
 * path -- a real request is waiting on POST /session to respond before they can start
 * talking -- so a slow (not just down) easyHMSAPI needs an explicit timeout, not just a
 * try/catch, or one hanging request could stall every new call.
 *
 * Never throws, never blocks session creation: resolves to `permissions: []` for every
 * failure mode (no hmsAccessToken, network error, non-2xx, timeout). An empty set still
 * allows every TOOL_PERMISSIONS `anyOf: []` tool; it denies every permission-gated one --
 * correct deny-by-default for a session Vita couldn't verify. */
export async function resolveSessionPermissions(
  hms: HmsClient,
  userId: string,
  hmsAccessToken: string | undefined,
  timeoutMs = Number(process.env.HMS_PERMISSIONS_FETCH_TIMEOUT_MS ?? 2500),
): Promise<{ permissions: string[]; hospitalId: string | null }> {
  if (!hmsAccessToken) return { permissions: [], hospitalId: null };
  try {
    const result = await withTimeout(hms.getUserPermissions(userId, hmsAccessToken), timeoutMs);
    return { permissions: result.permissionKeys, hospitalId: result.hospitalId };
  } catch (err) {
    console.error(
      JSON.stringify({
        type: 'SESSION_PERMISSIONS_RESOLVE_FAILED',
        userId,
        error: err instanceof Error ? err.message : String(err),
      }),
    );
    return { permissions: [], hospitalId: null };
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}
