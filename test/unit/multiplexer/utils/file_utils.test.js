// Copyright 2024 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  FileLock,
} = require("../../../../debug_router_connector/dist/cjs/src/multiplexer/utils/FileLock");

function createTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "debug-router-mux-test-"));
}

function cleanupTempDir(directory) {
  fs.rmSync(directory, { recursive: true, force: true });
}

function writeLockOwner(lockPath, owner) {
  fs.writeFileSync(
    path.join(lockPath, "owner.json"),
    JSON.stringify({
      token: `${owner.pid}-${owner.createdAt}-test`,
      ...owner,
    })
  );
}

describe("multiplexer FileLock", function () {
  let tempDir;

  beforeEach(function () {
    tempDir = createTempDir();
  });

  afterEach(function () {
    cleanupTempDir(tempDir);
  });

  it("allows only one holder for the same path", function () {
    const lockPath = path.join(tempDir, "spawn.lock");
    const first = new FileLock(lockPath);
    const second = new FileLock(lockPath);

    assert.strictEqual(first.acquire(), true);
    const ownerBeforeRepeatedAcquire = first.readOwner();
    assert.strictEqual(first.acquire(), true);
    const firstOwner = first.readOwner();
    assert.deepStrictEqual(firstOwner, ownerBeforeRepeatedAcquire);
    assert.strictEqual(firstOwner.pid, process.pid);
    assert.strictEqual(typeof firstOwner.token, "string");
    assert.notStrictEqual(firstOwner.token, "");
    assert.strictEqual(
      fs.readFileSync(path.join(lockPath, "owner.json"), "utf8"),
      JSON.stringify(firstOwner)
    );
    assert.strictEqual(second.acquire(), false);

    first.release();
    assert.strictEqual(second.acquire(), true);
    second.release();
  });

  it("does not let release remove a lock not owned by this instance", function () {
    const lockPath = path.join(tempDir, "spawn.lock");
    fs.mkdirSync(lockPath);

    const lock = new FileLock(lockPath);
    lock.release();

    assert.strictEqual(fs.existsSync(lockPath), true);
  });

  it("does not let release remove a lock recreated by another owner", function () {
    const lockPath = path.join(tempDir, "recreated.lock");
    const lock = new FileLock(lockPath);

    assert.strictEqual(lock.acquire(), true);
    fs.rmSync(lockPath, { recursive: true, force: true });
    fs.mkdirSync(lockPath);
    fs.writeFileSync(
      path.join(lockPath, "owner.json"),
      JSON.stringify({
        pid: process.pid,
        createdAt: Date.now(),
        token: "another-owner",
      })
    );

    lock.release();

    assert.strictEqual(fs.existsSync(lockPath), true);
    assert.strictEqual(
      new FileLock(lockPath).readOwner().token,
      "another-owner"
    );

    fs.rmSync(lockPath, { recursive: true, force: true });
    assert.strictEqual(lock.acquire(), true);
    assert.notStrictEqual(lock.readOwner(), null);
    lock.release();
  });

  it("does not trust local ownership after the lock is replaced", function () {
    const lockPath = path.join(tempDir, "replaced-before-acquire.lock");
    const lock = new FileLock(lockPath);
    const replacementOwner = {
      pid: process.pid,
      createdAt: Date.now(),
      token: "replacement-owner",
    };

    assert.strictEqual(lock.acquire(), true);
    fs.rmSync(lockPath, { recursive: true, force: true });
    fs.mkdirSync(lockPath);
    fs.writeFileSync(
      path.join(lockPath, "owner.json"),
      JSON.stringify(replacementOwner)
    );

    assert.strictEqual(lock.acquire(), false);
    assert.deepStrictEqual(
      new FileLock(lockPath).readOwner(),
      replacementOwner
    );
    lock.release();
    assert.deepStrictEqual(
      new FileLock(lockPath).readOwner(),
      replacementOwner
    );
  });

  it("throws when best-effort release fails", function () {
    const lockPath = path.join(tempDir, "release-failed.lock");
    const lock = new FileLock(lockPath);
    const originalRmSync = fs.rmSync;
    let removeAttempts = 0;

    assert.strictEqual(lock.acquire(), true);
    fs.rmSync = (targetPath, option) => {
      if (targetPath === lockPath) {
        removeAttempts++;
        throw new Error("persistent remove failure");
      }
      return originalRmSync(targetPath, option);
    };
    try {
      assert.throws(
        () => lock.release(),
        new RegExp(`Failed to release file lock: ${lockPath}`)
      );
    } finally {
      fs.rmSync = originalRmSync;
    }

    assert.strictEqual(removeAttempts, 1);
    assert.strictEqual(fs.existsSync(lockPath), true);
    lock.release();
    assert.strictEqual(fs.existsSync(lockPath), false);
  });

  it("keeps different lock paths independent", function () {
    const spawnLock = new FileLock(path.join(tempDir, "spawn.lock"));
    const secondLock = new FileLock(path.join(tempDir, "second.lock"));

    assert.strictEqual(spawnLock.acquire(), true);
    assert.strictEqual(secondLock.acquire(), true);

    spawnLock.release();
    secondLock.release();
  });

  it("returns null for missing, invalid JSON, and invalid owner shape", function () {
    const lockPath = path.join(tempDir, "spawn.lock");
    const lock = new FileLock(lockPath);

    assert.strictEqual(lock.readOwner(), null);

    fs.mkdirSync(lockPath);
    fs.writeFileSync(path.join(lockPath, "owner.json"), "{bad");
    assert.strictEqual(lock.readOwner(), null);

    fs.writeFileSync(
      path.join(lockPath, "owner.json"),
      JSON.stringify({
        pid: "1",
        createdAt: Date.now(),
      })
    );
    assert.strictEqual(lock.readOwner(), null);

    fs.writeFileSync(
      path.join(lockPath, "owner.json"),
      JSON.stringify({
        pid: 1,
        createdAt: Date.now(),
      })
    );
    assert.strictEqual(lock.readOwner(), null);

    for (const invalidOwner of [
      { pid: 1.5, createdAt: Date.now(), token: "token" },
      { pid: -1, createdAt: Date.now(), token: "token" },
      { pid: 1, createdAt: -1, token: "token" },
      { pid: 1, createdAt: Date.now(), token: "" },
    ]) {
      fs.writeFileSync(
        path.join(lockPath, "owner.json"),
        JSON.stringify(invalidOwner)
      );
      assert.strictEqual(lock.readOwner(), null);
    }
  });

  it("reports non-existent locks as not stale", function () {
    const lock = new FileLock(path.join(tempDir, "missing.lock"));

    assert.strictEqual(lock.cleanupStale(1000), false);
  });

  it("cleans stale locks and keeps fresh locks", function () {
    const now = Date.now();
    const staleLockPath = path.join(tempDir, "stale.lock");
    const freshLockPath = path.join(tempDir, "fresh.lock");

    fs.mkdirSync(staleLockPath);
    writeLockOwner(staleLockPath, {
      pid: process.pid,
      createdAt: now - 5000,
    });

    fs.mkdirSync(freshLockPath);
    writeLockOwner(freshLockPath, {
      pid: process.pid,
      createdAt: now,
    });

    const staleLock = new FileLock(staleLockPath);
    const freshLock = new FileLock(freshLockPath);

    assert.strictEqual(staleLock.cleanupStale(1000, now), true);
    assert.strictEqual(fs.existsSync(staleLockPath), false);
    assert.strictEqual(freshLock.cleanupStale(1000, now), false);
    assert.strictEqual(fs.existsSync(freshLockPath), true);
  });

  it("does not clean a stale lock when the owner changes before removal", function () {
    const now = Date.now();
    const lockPath = path.join(tempDir, "stale-owner-changed.lock");
    const lock = new FileLock(lockPath);
    const staleOwner = {
      pid: 1,
      createdAt: now - 5000,
      token: "stale-owner",
    };
    const freshOwner = {
      pid: process.pid,
      createdAt: now,
      token: "fresh-owner",
    };
    const originalTryRemove = lock.tryRemove.bind(lock);

    fs.mkdirSync(lockPath);
    fs.writeFileSync(
      path.join(lockPath, "owner.json"),
      JSON.stringify(staleOwner)
    );
    lock.tryRemove = (expectedOwner) => {
      fs.writeFileSync(
        path.join(lockPath, "owner.json"),
        JSON.stringify(freshOwner)
      );
      return originalTryRemove(expectedOwner);
    };

    assert.strictEqual(lock.cleanupStale(1000, now), false);
    assert.strictEqual(fs.existsSync(lockPath), true);
    assert.deepStrictEqual(new FileLock(lockPath).readOwner(), freshOwner);
  });

  it("treats ownerless and invalid-owner lock directories as stale", function () {
    const now = Date.now();
    const ownerlessLockPath = path.join(tempDir, "ownerless.lock");
    const invalidOwnerLockPath = path.join(tempDir, "invalid-owner.lock");

    fs.mkdirSync(ownerlessLockPath);
    fs.mkdirSync(invalidOwnerLockPath);
    fs.writeFileSync(path.join(invalidOwnerLockPath, "owner.json"), "{bad");

    assert.strictEqual(
      new FileLock(ownerlessLockPath).cleanupStale(
        Number.MAX_SAFE_INTEGER,
        now
      ),
      true
    );
    assert.strictEqual(
      new FileLock(invalidOwnerLockPath).cleanupStale(
        Number.MAX_SAFE_INTEGER,
        now
      ),
      true
    );
    assert.strictEqual(fs.existsSync(ownerlessLockPath), false);
    assert.strictEqual(fs.existsSync(invalidOwnerLockPath), false);
  });

  it("treats a lock with a dead owner process as stale", function () {
    const now = Date.now();
    const lockPath = path.join(tempDir, "dead-owner.lock");
    fs.mkdirSync(lockPath);
    writeLockOwner(lockPath, {
      pid: 987654321,
      createdAt: now,
    });

    assert.strictEqual(new FileLock(lockPath).cleanupStale(1000, now), true);
    assert.strictEqual(fs.existsSync(lockPath), false);
  });

  it("does not remove a replacement owner after cleaning its stale lock", function () {
    const now = Date.now();
    const lockPath = path.join(tempDir, "owned-stale.lock");
    const lock = new FileLock(lockPath);

    assert.strictEqual(lock.acquire(), true);
    const owner = lock.readOwner();
    writeLockOwner(lockPath, {
      ...owner,
      createdAt: now - 5000,
    });

    assert.strictEqual(lock.cleanupStale(1000, now), true);
    assert.strictEqual(fs.existsSync(lockPath), false);

    const replacement = new FileLock(lockPath);
    assert.strictEqual(replacement.acquire(), true);
    const replacementOwner = replacement.readOwner();

    lock.release();
    assert.deepStrictEqual(replacement.readOwner(), replacementOwner);
    assert.strictEqual(fs.existsSync(lockPath), true);
    replacement.release();

    assert.strictEqual(lock.acquire(), true);
    assert.notStrictEqual(lock.readOwner(), null);
    lock.release();
    assert.strictEqual(fs.existsSync(lockPath), false);
  });
});
