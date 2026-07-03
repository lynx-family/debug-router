// Copyright 2024 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

require("../register_ts");

const {
  readJsonFile,
  removeFileIfExists,
  writeFileAtomic,
  writeJsonAtomic,
} = require("../../../../debug_router_connector/src/multiplexer/utils/atomic_file");
const {
  FileLock,
} = require("../../../../debug_router_connector/src/multiplexer/utils/FileLock");

function createTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "debug-router-mux-test-"));
}

function cleanupTempDir(directory) {
  fs.rmSync(directory, { recursive: true, force: true });
}

describe("multiplexer atomic file utilities", function () {
  let tempDir;

  beforeEach(function () {
    tempDir = createTempDir();
  });

  afterEach(function () {
    cleanupTempDir(tempDir);
  });

  it("writes and reads JSON atomically", function () {
    const filePath = path.join(tempDir, "nested", "daemon.json");

    assert.strictEqual(readJsonFile(filePath), null);

    writeJsonAtomic(filePath, {
      pid: 1,
      protocolVersion: 1,
    });

    assert.deepStrictEqual(readJsonFile(filePath), {
      pid: 1,
      protocolVersion: 1,
    });
  });

  it("writes buffer content atomically", function () {
    const filePath = path.join(tempDir, "buffer.bin");

    writeFileAtomic(filePath, Buffer.from("hello"));

    assert.strictEqual(fs.readFileSync(filePath, "utf8"), "hello");
  });

  it("keeps the previous file when rename fails", function () {
    const filePath = path.join(tempDir, "daemon.json");
    fs.writeFileSync(filePath, "old");

    const originalRenameSync = fs.renameSync;
    fs.renameSync = function throwOnRename() {
      throw new Error("rename failed");
    };

    try {
      assert.throws(() => writeFileAtomic(filePath, "new"), /rename failed/);
    } finally {
      fs.renameSync = originalRenameSync;
    }

    assert.strictEqual(fs.readFileSync(filePath, "utf8"), "old");
    assert.deepStrictEqual(
      fs.readdirSync(tempDir).filter((name) => name.endsWith(".tmp")),
      []
    );
  });

  it("removes files only when they exist", function () {
    const filePath = path.join(tempDir, "daemon.json");

    assert.strictEqual(removeFileIfExists(filePath), false);
    fs.writeFileSync(filePath, "{}");
    assert.strictEqual(removeFileIfExists(filePath), true);
    assert.strictEqual(fs.existsSync(filePath), false);
  });

  it("rethrows non-ENOENT remove errors", function () {
    const filePath = path.join(tempDir, "daemon.json");
    const originalUnlinkSync = fs.unlinkSync;
    fs.unlinkSync = function throwOnUnlink() {
      const error = new Error("permission denied");
      error.code = "EACCES";
      throw error;
    };

    try {
      assert.throws(() => removeFileIfExists(filePath), /permission denied/);
    } finally {
      fs.unlinkSync = originalUnlinkSync;
    }
  });
});

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
    assert.strictEqual(first.acquire(), true);
    assert.strictEqual(first.isLocked(), true);
    assert.strictEqual(first.readOwner().pid, process.pid);
    assert.strictEqual(second.acquire(), false);

    first.release();
    assert.strictEqual(first.isLocked(), false);
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

  it("keeps different lock paths independent", function () {
    const spawnLock = new FileLock(path.join(tempDir, "spawn.lock"));
    const daemonLock = new FileLock(path.join(tempDir, "daemon.lock"));

    assert.strictEqual(spawnLock.acquire(), true);
    assert.strictEqual(daemonLock.acquire(), true);

    spawnLock.release();
    daemonLock.release();
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
  });

  it("reports non-existent locks as not stale", function () {
    const lock = new FileLock(path.join(tempDir, "missing.lock"));

    assert.strictEqual(lock.isStale(1000), false);
    assert.strictEqual(lock.cleanupStale(1000), false);
  });

  it("cleans stale locks and keeps fresh locks", function () {
    const now = Date.now();
    const staleLockPath = path.join(tempDir, "stale.lock");
    const freshLockPath = path.join(tempDir, "fresh.lock");

    fs.mkdirSync(staleLockPath);
    fs.writeFileSync(
      path.join(staleLockPath, "owner.json"),
      JSON.stringify({
        pid: 1,
        createdAt: now - 5000,
      })
    );

    fs.mkdirSync(freshLockPath);
    fs.writeFileSync(
      path.join(freshLockPath, "owner.json"),
      JSON.stringify({
        pid: process.pid,
        createdAt: now,
      })
    );

    const staleLock = new FileLock(staleLockPath);
    const freshLock = new FileLock(freshLockPath);

    assert.strictEqual(staleLock.cleanupStale(1000, now), true);
    assert.strictEqual(fs.existsSync(staleLockPath), false);
    assert.strictEqual(freshLock.cleanupStale(1000, now), false);
    assert.strictEqual(fs.existsSync(freshLockPath), true);
  });

  it("uses lock directory mtime when owner metadata is missing", function () {
    const now = Date.now();
    const staleLockPath = path.join(tempDir, "mtime-stale.lock");
    const freshLockPath = path.join(tempDir, "mtime-fresh.lock");

    fs.mkdirSync(staleLockPath);
    fs.mkdirSync(freshLockPath);
    fs.utimesSync(staleLockPath, new Date(now - 5000), new Date(now - 5000));
    fs.utimesSync(freshLockPath, new Date(now), new Date(now));

    assert.strictEqual(new FileLock(staleLockPath).isStale(1000, now), true);
    assert.strictEqual(new FileLock(freshLockPath).isStale(1000, now), false);
  });

  it("treats a lock with a dead owner process as stale", function () {
    const now = Date.now();
    const lockPath = path.join(tempDir, "dead-owner.lock");
    fs.mkdirSync(lockPath);
    fs.writeFileSync(
      path.join(lockPath, "owner.json"),
      JSON.stringify({
        pid: 987654321,
        createdAt: now,
      })
    );

    assert.strictEqual(new FileLock(lockPath).isStale(1000, now), true);
  });

  it("clears local locked state when cleaning a stale lock it owns", function () {
    const now = Date.now();
    const lockPath = path.join(tempDir, "owned-stale.lock");
    const lock = new FileLock(lockPath);

    assert.strictEqual(lock.acquire(), true);
    fs.writeFileSync(
      path.join(lockPath, "owner.json"),
      JSON.stringify({
        pid: process.pid,
        createdAt: now - 5000,
      })
    );

    assert.strictEqual(lock.cleanupStale(1000, now), true);
    assert.strictEqual(lock.isLocked(), false);
    assert.strictEqual(fs.existsSync(lockPath), false);
  });

  it("propagates unexpected acquire and stat errors", function () {
    const originalMkdirSync = fs.mkdirSync;
    fs.mkdirSync = function throwOnMkdir(targetPath, options) {
      if (targetPath === path.join(tempDir, "denied")) {
        const error = new Error("mkdir denied");
        error.code = "EACCES";
        throw error;
      }
      return originalMkdirSync.call(fs, targetPath, options);
    };

    try {
      assert.throws(
        () => new FileLock(path.join(tempDir, "denied", "lock")).acquire(),
        /mkdir denied/
      );
    } finally {
      fs.mkdirSync = originalMkdirSync;
    }

    const lockPath = path.join(tempDir, "stat-error.lock");
    fs.mkdirSync(lockPath);
    const originalStatSync = fs.statSync;
    fs.statSync = function throwOnStat(targetPath) {
      if (targetPath === lockPath) {
        const error = new Error("stat denied");
        error.code = "EACCES";
        throw error;
      }
      return originalStatSync.call(fs, targetPath);
    };

    try {
      assert.throws(
        () => new FileLock(lockPath).isStale(1000, Date.now()),
        /stat denied/
      );
    } finally {
      fs.statSync = originalStatSync;
    }
  });

  it("treats ENOENT during stat as not stale", function () {
    const lockPath = path.join(tempDir, "racy.lock");
    const originalExistsSync = fs.existsSync;
    const originalStatSync = fs.statSync;

    fs.existsSync = function fakeExists(targetPath) {
      if (targetPath === lockPath) {
        return true;
      }
      return originalExistsSync.call(fs, targetPath);
    };
    fs.statSync = function throwOnStat(targetPath) {
      if (targetPath === lockPath) {
        const error = new Error("gone");
        error.code = "ENOENT";
        throw error;
      }
      return originalStatSync.call(fs, targetPath);
    };

    try {
      assert.strictEqual(
        new FileLock(lockPath).isStale(1000, Date.now()),
        false
      );
    } finally {
      fs.existsSync = originalExistsSync;
      fs.statSync = originalStatSync;
    }
  });
});
