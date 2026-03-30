/**
 * Async locking mechanism to serialize state mutations.
 * Prevents concurrent operations from corrupting job state.
 */

let chain = Promise.resolve();

/**
 * Execute a function with exclusive access to cron state.
 * Operations queue behind each other — no concurrent mutations.
 *
 * @param {Function} fn - Async function to execute under lock
 * @returns {Promise<*>} Result of fn
 */
export async function locked(fn) {
  let resolve;
  const prev = chain;
  chain = new Promise(r => { resolve = r; });

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
export function resetLock() {
  chain = Promise.resolve();
}
