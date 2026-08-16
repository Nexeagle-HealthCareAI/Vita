import { afterEach, describe, expect, it, vi } from 'vitest';
import { recordAuditEvent, initAuditStore, _setAuditStoreForTests, type AuditEvent } from '../src/audit.js';
import { PostgresAuditStore } from '../src/auditStore.js';

function fakeStore() {
  const store = Object.create(PostgresAuditStore.prototype) as PostgresAuditStore;
  store.ensureSchema = vi.fn().mockResolvedValue(undefined);
  store.insert = vi.fn().mockResolvedValue(undefined);
  store.purgeExpired = vi.fn().mockResolvedValue(0);
  return store;
}

function baseEvent(): AuditEvent {
  return { ts: 1, sessionId: 's1', userId: 'u1', role: 'ROLE_RECEPTIONIST', action: 'session_created', outcome: 'success' };
}

describe('recordAuditEvent', () => {
  afterEach(() => _setAuditStoreForTests(null));

  it('always logs to stdout regardless of whether a store is configured', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    recordAuditEvent(baseEvent());
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('"action":"session_created"'));
    logSpy.mockRestore();
  });

  it('is a no-op toward Postgres when no store is configured (default in every test/CI env)', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(() => recordAuditEvent(baseEvent())).not.toThrow();
    logSpy.mockRestore();
  });

  it('fire-and-forget writes to the configured store', async () => {
    const store = fakeStore();
    _setAuditStoreForTests(store);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const event = baseEvent();
    recordAuditEvent(event);
    await Promise.resolve(); // let the fire-and-forget insert() promise settle

    expect(store.insert).toHaveBeenCalledWith(event);
    logSpy.mockRestore();
  });

  it('a store write failure is caught and logged, never thrown', async () => {
    const store = fakeStore();
    (store.insert as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('connection refused'));
    _setAuditStoreForTests(store);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(() => recordAuditEvent(baseEvent())).not.toThrow();
    await Promise.resolve();
    await Promise.resolve();

    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('AUDIT_WRITE_FAILED'));
    logSpy.mockRestore();
    errorSpy.mockRestore();
  });
});

describe('initAuditStore', () => {
  afterEach(() => _setAuditStoreForTests(null));

  it('is a no-op when no store is configured', async () => {
    await expect(initAuditStore()).resolves.toBeUndefined();
  });

  it('calls ensureSchema() and an initial purgeExpired(365) (AUDIT_RETENTION_DAYS default) when a store is configured', async () => {
    const store = fakeStore();
    _setAuditStoreForTests(store);

    await initAuditStore();

    expect(store.ensureSchema).toHaveBeenCalledOnce();
    expect(store.purgeExpired).toHaveBeenCalledWith(365);
  });
});
