/**
 * Run `worker` over `items` with at most `limit` in flight.
 *
 * Bounded because ingestion is hundreds of writes against somebody's API, and
 * an unbounded `Promise.all` over that is how a benchmark earns a rate-limit
 * ban halfway through a paid run.
 */
export async function pool<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;

  const runner = async (): Promise<void> => {
    while (true) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      results[index] = await worker(items[index] as T, index);
    }
  };

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, runner));
  return results;
}
