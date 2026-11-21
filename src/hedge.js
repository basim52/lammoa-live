// Hedged requests: start task 0; if it hasn't answered after `delayMs`, also start task 1, and so on.
// First success wins. A failure starts the next task immediately. Rejects only when every task failed.
export function hedge(tasks, delayMs) {
  return new Promise((resolve, reject) => {
    let next = 0, failed = 0, done = false, lastErr;
    const start = () => {
      if (done || next >= tasks.length) return;
      const k = next++;
      Promise.resolve().then(tasks[k]).then(
        (v) => { if (!done) { done = true; resolve(v); } },
        (e) => { lastErr = e; failed++; if (failed === tasks.length) { if (!done) { done = true; reject(lastErr); } } else start(); },
      );
      setTimeout(start, delayMs);
    };
    start();
  });
}
