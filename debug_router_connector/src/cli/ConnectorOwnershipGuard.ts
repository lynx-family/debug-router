import fs from "fs";
import path from "path";
import os from "os";

export type ConnectorOwnershipGuardOptions = {
  stateDir?: string;
  pollIntervalMs?: number;
};

export class ConnectorOwnershipGuard {
  private readonly ownerPath: string;
  private readonly pollIntervalMs: number;

  constructor(options: ConnectorOwnershipGuardOptions = {}) {
    const stateDir =
      options.stateDir ?? path.join(os.homedir(), ".DebugRouterConnector");
    this.ownerPath = path.join(stateDir, "LatestDriverProcess");
    this.pollIntervalMs = options.pollIntervalMs ?? 100;
  }

  async wait(
    timeoutMs: number,
    takeover: boolean,
    signal?: AbortSignal,
  ): Promise<void> {
    if (takeover) {
      return;
    }
    const deadline = Date.now() + timeoutMs;
    while (this.hasLiveOwner()) {
      if (signal?.aborted) {
        throw abortError();
      }
      if (Date.now() >= deadline) {
        throw new Error("CONNECTOR_BUSY_TIMEOUT: DebugRouterConnector is active");
      }
      await wait(this.pollIntervalMs, signal);
    }
  }

  private hasLiveOwner(): boolean {
    let pid: number;
    try {
      const content = fs.readFileSync(this.ownerPath, "utf8").trim();
      pid = Number(content);
      if (!Number.isInteger(pid) || pid <= 0) {
        return false;
      }
    } catch (error: any) {
      if (error?.code === "ENOENT") {
        return false;
      }
      throw error;
    }

    try {
      process.kill(pid, 0);
      return true;
    } catch (error: any) {
      return error?.code !== "ESRCH";
    }
  }
}

function wait(timeoutMs: number, signal?: AbortSignal): Promise<void> {
  if (!signal) {
    return new Promise((resolve) => setTimeout(resolve, timeoutMs));
  }
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, timeoutMs);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function abortError(): Error {
  const error = new Error("Command aborted");
  error.name = "AbortError";
  return error;
}
