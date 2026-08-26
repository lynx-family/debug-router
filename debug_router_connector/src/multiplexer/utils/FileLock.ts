// Copyright 2026 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

import fs from "fs";
import path from "path";
import { randomBytes } from "crypto";

const FILE_LOCK_REMOVE_MAX_RETRIES = 3;
const FILE_LOCK_REMOVE_RETRY_DELAY_MS = 10;

export type FileLockOwner = {
  pid: number;
  createdAt: number;
  token: string; // with pid, createdAt and random bytes, used to identify the owner of the lock.
};

export type FileLockTokenFactory = (
  owner: Pick<FileLockOwner, "pid" | "createdAt">,
) => string;

export class FileLock {
  private locked = false;
  private owner: FileLockOwner | null = null;
  readonly lockPath: string;
  private readonly tokenFactory: FileLockTokenFactory;
  // used to generate tokens for the lock owners.
  // can be overridden to use custom token generation logic for testing or debugging purposes.

  constructor(
    lockPath: string,
    tokenFactory: FileLockTokenFactory = createDefaultToken,
  ) {
    this.lockPath = lockPath;
    this.tokenFactory = tokenFactory;
  }

  acquire(): boolean {
    if (this.locked) {
      return true;
    }

    const owner = createOwner(this.tokenFactory);
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

  release(): void {
    if (!this.locked) {
      return;
    }

    const owner = this.owner;
    if (!owner) {
      this.clearLocalState();
      return;
    }

    const removed = this.tryRemove(owner);

    // If the lock now belongs to another owner, this instance no longer owns it locally either.
    if (removed || !isSameOwner(this.readOwner(), owner)) {
      this.clearLocalState();
    }
  }

  isLocked(): boolean {
    return this.locked;
  }

  readOwner(): FileLockOwner | null {
    const ownerPath = this.getOwnerPath();
    if (!fs.existsSync(ownerPath)) {
      return null;
    }

    try {
      const owner = JSON.parse(fs.readFileSync(ownerPath, "utf8"));
      if (
        typeof owner?.pid === "number" &&
        Number.isFinite(owner.pid) &&
        typeof owner?.createdAt === "number" &&
        Number.isFinite(owner.createdAt) &&
        typeof owner?.token === "string"
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

  isLockOwnerAlive(): boolean {
    const owner = this.readOwner();
    return owner ? isProcessAlive(owner.pid) : false;
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

    // use lock mtime to check when owner.createdAt not exists.
    return now - this.getLockMtimeMs() > timeout;
  }

  cleanup(): boolean {
    const lastOwner = this.readOwner();
    return this.tryRemove(lastOwner);
  }

  cleanupStale(timeout: number, now: number = Date.now()): boolean {
    const staleOwner = this.readOwner();
    if (!this.isLockStateStale(staleOwner, timeout, now)) {
      return false;
    }

    return this.tryRemove(staleOwner);
  }

  tryRemove(expectedOwner: FileLockOwner | null): boolean {
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
    fs.writeFileSync(this.getOwnerPath(), JSON.stringify(owner, null, 2));
  }

  private getOwnerPath(): string {
    return path.join(this.lockPath, "owner.json");
  }

  private getLockMtimeMs(): number {
    try {
      return fs.statSync(this.lockPath).mtimeMs;
    } catch (error: any) {
      if (error?.code === "ENOENT") {
        return Date.now();
      }

      throw error;
    }
  }

  private clearLocalState(): void {
    this.locked = false;
    this.owner = null;
  }
}

function createOwner(tokenFactory: FileLockTokenFactory): FileLockOwner {
  const pid = process.pid;
  const createdAt = Date.now();
  return {
    pid,
    createdAt,
    token: tokenFactory({
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
