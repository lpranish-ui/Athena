/** Account leases prevent a request started before logout from repopulating storage. */
export interface OfflineStorageAdapter {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  getAllKeys(): Promise<readonly string[]>;
  multiRemove(keys: string[]): Promise<void>;
}

export interface OfflineAccountLease { readonly accountId: string; readonly epoch: number }
export const PRIVATE_OFFLINE_PREFIX = 'athena.private.v1.';
export const LEGACY_OFFLINE_PREFIX = 'athena.offline.';

export class OfflineAccountChangedError extends Error {
  constructor() { super('Your account changed. Reopen this screen to continue.'); this.name = 'OfflineAccountChangedError'; }
}

export function isOfflineNetworkError(error: unknown): boolean {
  return error instanceof Error && 'status' in error && error.status === 0;
}

/** Storage operations share a serial queue, including deletion. Invalidation
 * happens synchronously, before queued deletion waits for an in-flight write. */
export function createPrivateOfflineStorage(storage: OfflineStorageAdapter) {
  let accountId: string | null = null;
  let epoch = 0;
  let tail: Promise<unknown> = Promise.resolve();
  const serial = <T>(task: () => Promise<T>): Promise<T> => {
    const result = tail.then(task);
    tail = result.catch(() => undefined);
    return result;
  };
  const accountPrefix = (id: string) => `${PRIVATE_OFFLINE_PREFIX}${encodeURIComponent(id)}.`;
  const current = (lease: OfflineAccountLease) => lease.accountId === accountId && lease.epoch === epoch;
  const assertCurrent = (lease: OfflineAccountLease) => { if (!current(lease)) throw new OfflineAccountChangedError(); };
  const keyFor = (lease: OfflineAccountLease, path: string) => `${accountPrefix(lease.accountId)}${path}`;
  const purge = async (predicate: (key: string) => boolean) => {
    const keys = (await storage.getAllKeys()).filter(predicate);
    if (keys.length) await storage.multiRemove(keys);
  };

  return {
    current,
    assertCurrent,
    lease(): OfflineAccountLease {
      if (!accountId) throw new OfflineAccountChangedError();
      return { accountId, epoch };
    },
    setAccount(next: string | null): Promise<void> {
      const previous = accountId;
      if (previous !== next) { accountId = next; epoch += 1; }
      return serial(() => purge((key) => key.startsWith(LEGACY_OFFLINE_PREFIX)
        || (next === null && key.startsWith(PRIVATE_OFFLINE_PREFIX))
        || (!!previous && previous !== next && key.startsWith(accountPrefix(previous)))));
    },
    clear(): Promise<void> {
      accountId = null;
      epoch += 1;
      return serial(() => purge((key) => key.startsWith(PRIVATE_OFFLINE_PREFIX) || key.startsWith(LEGACY_OFFLINE_PREFIX)));
    },
    read<T>(lease: OfflineAccountLease, path: string): Promise<T | null> {
      return serial(async () => {
        assertCurrent(lease);
        const raw = await storage.getItem(keyFor(lease, path));
        assertCurrent(lease);
        if (!raw) return null;
        try { return JSON.parse(raw) as T; } catch { return null; }
      });
    },
    write(lease: OfflineAccountLease, path: string, value: unknown): Promise<void> {
      return serial(async () => {
        assertCurrent(lease);
        await storage.setItem(keyFor(lease, path), JSON.stringify(value));
        assertCurrent(lease);
      });
    },
    remove(lease: OfflineAccountLease, paths: string[]): Promise<void> {
      return serial(async () => {
        assertCurrent(lease);
        await storage.multiRemove(paths.map((path) => keyFor(lease, path)));
        assertCurrent(lease);
      });
    },
    list(lease: OfflineAccountLease, namespace: string): Promise<string[]> {
      return serial(async () => {
        assertCurrent(lease);
        const prefix = keyFor(lease, namespace);
        const keys = await storage.getAllKeys();
        assertCurrent(lease);
        return keys.filter((key) => key.startsWith(prefix)).map((key) => key.slice(accountPrefix(lease.accountId).length));
      });
    },
  };
}
