/** Liveness probes for pids the test did not spawn itself, so has no handle for. */

/** True while the pid exists. Signal 0 checks liveness without delivering anything. */
export function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function waitForDeath(pid, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  return !isAlive(pid);
}
