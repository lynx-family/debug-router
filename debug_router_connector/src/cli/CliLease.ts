import fs from "fs";
import path from "path";
import crypto from "crypto";
import os from "os";

export type CliLeaseOptions = {
  stateDir?: string;
  pollIntervalMs?: number;
};

export class CliLease {
  readonly token = crypto.randomUUID();
  private readonly stateDir: string;
  private readonly pollIntervalMs: number;
  private readonly lockDir: string;
  private readonly ownerPath: string;
  private readonly recoveryDir: string;
  acquired = false;

  constructor(options: CliLeaseOptions = {}) {
    this.stateDir =
      options.stateDir ?? path.join(os.homedir(), ".DebugRouterConnector");
    this.pollIntervalMs = options.pollIntervalMs ?? 100;
    this.lockDir = path.join(this.stateDir, "cli-lock");
    this.ownerPath = path.join(this.lockDir, "owner.json");
    this.recoveryDir = path.join(
      this.stateDir,
      `cli-lock-recovery-${this.token}`,
    );
  }

  async acquire(timeoutMs = 60000, signal?: AbortSignal): Promise<void> {
    fs.mkdirSync(this.stateDir, { recursive: true });
    const deadline = Date.now() + timeoutMs;
    while (true) {
      if (signal?.aborted) {
        throw abortError();
      }
      try {
        fs.mkdirSync(this.lockDir);
        fs.writeFileSync(
          this.ownerPath,
          JSON.stringify({ pid: process.pid, token: this.token }),
          { flag: "wx" },
        );
        this.acquired = true;
        return;
      } catch (error: any) {
        if (error?.code !== "EEXIST") {
          throw error;
        }
        if (this.clearStaleOwner()) {
          continue;
        }
        if (Date.now() >= deadline) {
          throw new Error("CONNECTOR_BUSY_TIMEOUT: another CLI is active");
        }
        await wait(this.pollIntervalMs, signal);
      }
    }
  }

  async release(): Promise<void> {
    if (!this.acquired) {
      return;
    }
    try {
      const owner = JSON.parse(fs.readFileSync(this.ownerPath, "utf8"));
      if (owner.token !== this.token) {
        return;
      }
      fs.rmSync(this.lockDir, { recursive: true, force: true });
      this.acquired = false;
    } catch (error: any) {
      if (error?.code !== "ENOENT") {
        throw error;
      }
      this.acquired = false;
    }
  }

  private clearStaleOwner(): boolean {
    let observedToken: string | undefined;
    try {
      const owner = JSON.parse(fs.readFileSync(this.ownerPath, "utf8"));
      observedToken = owner.token;
      if (this.isAlive(owner.pid)) {
        return false;
      }
    } catch (error: any) {
      if (error?.code !== "ENOENT" && !(error instanceof SyntaxError)) {
        return false;
      }
    }

    try {
      fs.renameSync(this.lockDir, this.recoveryDir);
    } catch (error: any) {
      return false;
    }

    try {
      let recovered: any;
      try {
        recovered = JSON.parse(
          fs.readFileSync(path.join(this.recoveryDir, "owner.json"), "utf8"),
        );
      } catch (error: any) {
        if (error?.code !== "ENOENT" && !(error instanceof SyntaxError)) {
          throw error;
        }
      }
      if (
        recovered &&
        (recovered.token !== observedToken || this.isAlive(recovered.pid))
      ) {
        fs.renameSync(this.recoveryDir, this.lockDir);
        return false;
      }
      fs.rmSync(this.recoveryDir, { recursive: true, force: true });
      return true;
    } catch (error) {
      if (!fs.existsSync(this.lockDir) && fs.existsSync(this.recoveryDir)) {
        fs.renameSync(this.recoveryDir, this.lockDir);
      }
      return false;
    }
  }

  private isAlive(pid: unknown): boolean {
    if (!Number.isInteger(pid) || (pid as number) <= 0) {
      return false;
    }
    try {
      process.kill(pid as number, 0);
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
