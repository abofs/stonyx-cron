/**
 * Async locking mechanism to serialize state mutations.
 * Prevents concurrent operations from corrupting job state.
 */

let chain: Promise<void> = Promise.resolve();

/**
 * Execute a function with exclusive access to cron state.
 * Operations queue behind each other - no concurrent mutations.
 */
export async function locked<T>(fn: () => T | Promise<T>): Promise<T> {
  let resolve!: () => void;
  const prev = chain;
  chain = new Promise<void>(r => { resolve = r; });

  await prev;

  try {
    return await fn();
  } finally {
    resolve();
  }
}

/**
 * Reset the lock chain. Only for testing.
 */
export function resetLock(): void {
  chain = Promise.resolve();
}
