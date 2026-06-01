export function boundedConcurrency(value, options = {}) {
  const defaultValue = Number.isFinite(Number(options.defaultValue))
    ? Math.max(1, Math.trunc(Number(options.defaultValue)))
    : 1;
  const max = Number.isFinite(Number(options.max))
    ? Math.max(1, Math.trunc(Number(options.max)))
    : 8;
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return Math.min(max, defaultValue);
  }
  return Math.min(max, Math.max(1, Math.trunc(number)));
}

export async function runJobQueue(jobs, worker, options = {}) {
  const items = Array.isArray(jobs) ? jobs : [];
  const totalCount = items.length;
  const concurrency = totalCount
    ? Math.min(totalCount, boundedConcurrency(options.concurrency, {
        defaultValue: options.defaultConcurrency || 1,
        max: options.maxConcurrency || 8
      }))
    : 0;
  const results = new Array(totalCount);
  const startedMs = Date.now();
  let nextIndex = 0;
  let activeCount = 0;
  let maxActiveCount = 0;

  async function runWorker(workerIndex) {
    while (nextIndex < totalCount) {
      const index = nextIndex;
      nextIndex += 1;
      const job = items[index];
      const jobStartedMs = Date.now();
      activeCount += 1;
      maxActiveCount = Math.max(maxActiveCount, activeCount);
      try {
        const value = await worker(job, { index, workerIndex });
        results[index] = {
          ok: true,
          job,
          value,
          startedAt: new Date(jobStartedMs).toISOString(),
          finishedAt: new Date().toISOString(),
          durationMs: Date.now() - jobStartedMs
        };
      } catch (error) {
        results[index] = {
          ok: false,
          job,
          error,
          errorMessage: error?.message || String(error),
          startedAt: new Date(jobStartedMs).toISOString(),
          finishedAt: new Date().toISOString(),
          durationMs: Date.now() - jobStartedMs
        };
        if (options.throwOnError !== false) {
          throw error;
        }
      } finally {
        activeCount -= 1;
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, (_, workerIndex) => runWorker(workerIndex)));
  const successCount = results.filter((result) => result?.ok).length;
  const failureCount = results.filter((result) => result && !result.ok).length;
  return {
    concurrency,
    totalCount,
    successCount,
    failureCount,
    durationMs: Date.now() - startedMs,
    maxActiveCount,
    results
  };
}
