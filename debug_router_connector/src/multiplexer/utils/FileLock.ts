// Copyright 2024 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

import fs from "fs";
import path from "path";

export type FileLockOwner = {
  pid: number;
  createdAt: number;
};

export class FileLock {
  private locked = false;

  constructor(readonly lockPath: string) {}

  acquire(): boolean {
    if (this.locked) {
      return true;
    }

    try {
      fs.mkdirSync(path.dirname(this.lockPath), { recursive: true });
      fs.mkdirSync(this.lockPath);
      this.writeOwner();
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

    fs.rmSync(this.lockPath, { recursive: true, force: true });
    this.locked = false;
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
        Number.isFinite(owner.createdAt)
      ) {
        return owner;
      }
    } catch (_error) {
      return null;
    }

    return null;
  }

  isStale(timeout: number, now: number = Date.now()): boolean {
    if (!fs.existsSync(this.lockPath)) {
      return false;
    }

    const owner = this.readOwner();
    if (owner) {
      return now - owner.createdAt > timeout;
    }

    return now - this.getLockMtimeMs() > timeout;
  }

  cleanupStale(timeout: number, now: number = Date.now()): boolean {
    if (!this.isStale(timeout, now)) {
      return false;
    }

    fs.rmSync(this.lockPath, { recursive: true, force: true });
    if (this.locked) {
      this.locked = false;
    }
    return true;
  }

  private writeOwner(): void {
    const owner: FileLockOwner = {
      pid: process.pid,
      createdAt: Date.now(),
    };
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
}
