import { describe, expect, it, vi } from 'vitest';
import { RelaySessionRegistry } from '../src/relaySessionRegistry.js';
import type { ConnectionRelay } from '../src/relay.js';

function fakeRelay() {
  return { close: vi.fn() } as unknown as ConnectionRelay;
}

describe('RelaySessionRegistry', () => {
  it('evict() force-closes and removes the registered relay for a sessionId', () => {
    const registry = new RelaySessionRegistry();
    const relay = fakeRelay();
    registry.register('sess-1', relay);

    registry.evict('sess-1');

    expect(relay.close).toHaveBeenCalledTimes(1);
    // A second evict() on the same (now-removed) key is a no-op, not a second close.
    registry.evict('sess-1');
    expect(relay.close).toHaveBeenCalledTimes(1);
  });

  it('evict() is a no-op when nothing is registered for that sessionId', () => {
    const registry = new RelaySessionRegistry();
    expect(() => registry.evict('never-registered')).not.toThrow();
  });

  it('register() overwrites whatever was previously registered for a sessionId, without closing it', () => {
    const registry = new RelaySessionRegistry();
    const relayA = fakeRelay();
    const relayB = fakeRelay();

    registry.register('sess-1', relayA);
    registry.register('sess-1', relayB); // simulates B taking over the same key

    expect(relayA.close).not.toHaveBeenCalled(); // overwriting isn't evict()'s job

    registry.evict('sess-1'); // should close B, the current occupant, not A
    expect(relayB.close).toHaveBeenCalledTimes(1);
    expect(relayA.close).not.toHaveBeenCalled();
  });

  it('unregister() removes the entry only if the caller still owns it (identity match)', () => {
    const registry = new RelaySessionRegistry();
    const relay = fakeRelay();
    registry.register('sess-1', relay);

    registry.unregister('sess-1', relay);

    // Now nothing is registered -- evict() should be a no-op (proves removal happened).
    registry.evict('sess-1');
    expect(relay.close).not.toHaveBeenCalled();
  });

  it('unregister() is a no-op when a different, newer instance now owns that sessionId key', () => {
    const registry = new RelaySessionRegistry();
    const relayA = fakeRelay();
    const relayB = fakeRelay();

    registry.register('sess-1', relayA);
    registry.register('sess-1', relayB); // B has since taken over

    registry.unregister('sess-1', relayA); // A's own (stale) close handler firing late

    // B must still be the registered occupant -- evict() should close B, not be a no-op.
    registry.evict('sess-1');
    expect(relayB.close).toHaveBeenCalledTimes(1);
    expect(relayA.close).not.toHaveBeenCalled();
  });
});
