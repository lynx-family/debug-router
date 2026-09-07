// Copyright 2026 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

import fs from "fs";
import path from "path";
import { randomBytes } from "crypto";

const FILE_LOCK_REMOVE_MAX_RETRIES = 3;
const FILE_LOCK_REMOVE_RETRY_DELAY_MS = 10;

type FileLockOwner = {
  pid: number;
  createdAt: number;
  token: string; // with pid, createdAt and random bytes, used to identify the owner of the lock.
};

export class FileLock {
  private locked = false;
  private owner: FileLockOwner | null = null;
  private readonly lockPath: string;

  constructor(lockPath: string) {
    this.lockPath = lockPath;
  }

  acquire(): boolean {
    if (this.locked) {
      if (this.owner && isSameOwner(this.readOwner(), this.owner)) {
        return true;
      }
      this.clearLocalState();
    }

    const owner = createOwner();
    try {
      fs.mkdirSync(path.dirname(this.lockPath), { recursive: true });
      fs.mkdirSync(this.lockPath);
      this.writeOwner(owner);
      this.owner = owner;
      this.locked = true;
      return true;
    } catch (error: any) {
      if (error?.code === "EEXIST") {
        return false;
      }

      throw error;
    }
  }

  /**
   * Best-effort release. If another valid owner has taken over, local
   * ownership is cleared without removing the replacement lock. If the same
   * owner remains after a removal failure, an error is thrown.
   */
  release(): void {
    if (!this.locked) {
      return;
    }

    const owner = this.owner;
    if (!owner) {
      this.clearLocalState();
      return;
    }

    if (this.tryRemove(owner)) {
      this.clearLocalState();
      return;
    }

    if (!isSameOwner(this.readOwner(), owner)) {
      this.clearLocalState();
      return;
    }

    throw new Error(`Failed to release file lock: ${this.lockPath}`);
  }

  private readOwner(): FileLockOwner | null {
    const ownerPath = this.getOwnerPath();
    if (!fs.existsSync(ownerPath)) {
      return null;
    }

    try {
      const owner = JSON.parse(fs.readFileSync(ownerPath, "utf8"));
      if (
        Number.isSafeInteger(owner?.pid) &&
        owner.pid > 0 &&
        Number.isSafeInteger(owner?.createdAt) &&
        owner.createdAt > 0 &&
        typeof owner?.token === "string" &&
        owner.token.length > 0
      ) {
        return {
          pid: owner.pid,
          createdAt: owner.createdAt,
          token: owner.token,
        };
      }
    } catch (_error) {
      return null;
    }

    return null;
  }

  private isLockStateStale(
    owner: FileLockOwner | null,
    timeout: number,
    now: number,
  ): boolean {
    if (!fs.existsSync(this.lockPath)) {
      return false;
    }

    if (owner) {
      if (!isProcessAlive(owner.pid)) {
        return true;
      }
      return now - owner.createdAt > timeout;
    }

    return true;
  }

  cleanupStale(timeout: number, now: number = Date.now()): boolean {
    const staleOwner = this.readOwner();
    if (!this.isLockStateStale(staleOwner, timeout, now)) {
      return false;
    }

    return this.tryRemove(staleOwner);
  }

  private tryRemove(expectedOwner: FileLockOwner | null): boolean {
    try {
      if (!fs.existsSync(this.lockPath)) {
        return true;
      }

      const owner = this.readOwner();

      if (!isSameOwner(expectedOwner, owner)) {
        return false;
      }

      // Best-effort removal: compare owners first to reduce the risk of
      // accidentally deleting a lock held by someone else.
      fs.rmSync(this.lockPath, {
        recursive: true,
        force: true,
        maxRetries: FILE_LOCK_REMOVE_MAX_RETRIES,
        retryDelay: FILE_LOCK_REMOVE_RETRY_DELAY_MS,
      });
      return true;
    } catch (_error) {
      return false;
    }
  }

  private writeOwner(owner: FileLockOwner): void {
    fs.writeFileSync(this.getOwnerPath(), JSON.stringify(owner));
  }

  private getOwnerPath(): string {
    return path.join(this.lockPath, "owner.json");
  }

  private clearLocalState(): void {
    this.locked = false;
    this.owner = null;
  }
}

function createOwner(): FileLockOwner {
  const pid = process.pid;
  const createdAt = Date.now();
  return {
    pid,
    createdAt,
    token: createDefaultToken({
      pid,
      createdAt,
    }),
  };
}

function createDefaultToken({
  pid,
  createdAt,
}: Pick<FileLockOwner, "pid" | "createdAt">): string {
  return `${pid}-${createdAt}-${randomBytes(8).toString("hex")}`;
}

function isSameOwner(
  left: FileLockOwner | null,
  right: FileLockOwner | null,
): boolean {
  if (!left || !right) {
    return left === right;
  }

  return (
    left.pid === right.pid &&
    left.createdAt === right.createdAt &&
    left.token === right.token
  );
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch (error: any) {
    return error?.code === "EPERM";
  }
}
