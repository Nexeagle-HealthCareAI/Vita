import { afterEach, describe, expect, it, vi } from 'vitest';
// @ts-expect-error -- ioredis-mock has no bundled types
import RedisMock from 'ioredis-mock';
import type { Redis } from 'ioredis';
import { InMemoryTicketStore, RedisTicketStore, type StoredTicket } from '../src/ticketStore.js';

function record(overrides: Partial<StoredTicket> = {}): StoredTicket {
  return {
    claims: { sub: 'user-1' },
    resumeIntent: null,
    consentGiven: false,
    expiresAt: Date.now() + 30_000,
    ...overrides,
  };
}

describe('RedisTicketStore', () => {
  it('lets one instance redeem a ticket a DIFFERENT instance issued -- the entire reason this exists', async () => {
    // Two store objects over one Redis, standing in for two gateway pods behind a plain
    // load balancer: the ticket POST lands on pod A, the WS upgrade lands on pod B. With
    // the in-memory store this fails outright (B has never heard of the ticket), which is
    // total breakage at N>1, not degradation.
    const redis = new RedisMock() as Redis;
    const podA = new RedisTicketStore(redis);
    const podB = new RedisTicketStore(redis);

    await podA.put('tkt-1', record({ claims: { sub: 'user-42' } }), 30_000);
    const redeemed = await podB.take('tkt-1');

    expect(redeemed?.claims.sub).toBe('user-42');
  });

  it('is single-use across instances -- a second take() anywhere returns null', async () => {
    // GETDEL is one atomic round trip precisely so two pods racing the same ticket can't
    // both win, which a GET-then-DEL pair would allow.
    const redis = new RedisMock() as Redis;
    const podA = new RedisTicketStore(redis);
    const podB = new RedisTicketStore(redis);

    await podA.put('tkt-1', record(), 30_000);

    expect(await podB.take('tkt-1')).not.toBeNull();
    expect(await podA.take('tkt-1')).toBeNull();
    expect(await podB.take('tkt-1')).toBeNull();
  });

  it('returns null for an unknown ticket', async () => {
    const store = new RedisTicketStore(new RedisMock() as Redis);
    expect(await store.take('never-issued')).toBeNull();
  });

  it('refuses a stored ticket whose own expiresAt has passed, even if the key outlived it', async () => {
    // Belt-and-braces against clock skew / a TTL that didn't fire: the record carries its
    // own deadline and is re-checked on read.
    const store = new RedisTicketStore(new RedisMock() as Redis);
    await store.put('tkt-1', record({ expiresAt: Date.now() - 1 }), 30_000);

    expect(await store.take('tkt-1')).toBeNull();
  });

  it('healthy() reports false when the client cannot ping, rather than throwing', async () => {
    const brokenRedis = { ping: vi.fn().mockRejectedValue(new Error('ECONNREFUSED')) } as unknown as Redis;
    const store = new RedisTicketStore(brokenRedis);

    await expect(store.healthy()).resolves.toBe(false);
  });
});

describe('InMemoryTicketStore', () => {
  let store: InMemoryTicketStore | undefined;

  afterEach(() => store?.stop());

  it('round-trips a ticket and enforces single-use', async () => {
    store = new InMemoryTicketStore(60_000);
    await store.put('tkt-1', record(), 30_000);

    expect(await store.take('tkt-1')).not.toBeNull();
    expect(await store.take('tkt-1')).toBeNull();
  });

  it('refuses (and drops) an expired ticket', async () => {
    store = new InMemoryTicketStore(60_000);
    await store.put('tkt-1', record({ expiresAt: Date.now() - 1 }), 30_000);

    expect(await store.take('tkt-1')).toBeNull();
    expect(store.size).toBe(0); // taken out of the map even though it was expired
  });

  it('sweep() drops expired entries that nothing ever tried to redeem', async () => {
    store = new InMemoryTicketStore(60_000);
    await store.put('live', record(), 30_000);
    await store.put('stale', record({ expiresAt: Date.now() - 1 }), 30_000);

    store.sweep();

    expect(store.size).toBe(1);
    expect(await store.take('live')).not.toBeNull();
  });

  it('is always healthy -- nothing external to be unhealthy about', async () => {
    store = new InMemoryTicketStore(60_000);
    await expect(store.healthy()).resolves.toBe(true);
  });
});
