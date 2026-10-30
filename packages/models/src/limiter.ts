/** Counting semaphore: `limit(n)` caps concurrent async tasks (nightly flex calls n=4, live runs n=6). */
export function createLimiter(max: number) {
  let active = 0;
  const queue: (() => void)[] = [];
  const next = () => {
    active--;
    queue.shift()?.();
  };
  return async function run<T>(fn: () => Promise<T>): Promise<T> {
    if (active >= max) await new Promise<void>((res) => queue.push(res));
    active++;
    try {
      return await fn();
    } finally {
      next();
    }
  };
}

export const liveLimiter = createLimiter(6);
export const flexLimiter = createLimiter(4);
