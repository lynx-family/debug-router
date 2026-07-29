// Copyright 2024 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

require("../register_ts");

const connectorRoot = path.join(
  __dirname,
  "../../../../debug_router_connector"
);
const rewire = require(require.resolve("rewire", {
  paths: [connectorRoot],
}));
const atomicFileModulePath = path.join(
  connectorRoot,
  "src/multiplexer/utils/atomic_file.ts"
);
const fileLockModulePath = path.join(
  connectorRoot,
  "src/multiplexer/utils/FileLock.ts"
);
const writeFileAtomicModulePath = require.resolve("write-file-atomic", {
  paths: [connectorRoot],
});
const atomicFileModule = rewire(atomicFileModulePath);
const {
  readJsonFile,
  removeFileIfExists,
  writeFileAtomic,
  writeJsonAtomic,
} = atomicFileModule;
const {
  FileLock,
} = require("../../../../debug_router_connector/src/multiplexer/utils/FileLock");

function rewireModuleFs(modulePath, overrides) {
  const rewiredModule = rewire(modulePath);
  const moduleFs = rewiredModule.__get__("fs");
  const localFs = Object.assign(Object.create(moduleFs), overrides);
  rewiredModule.__set__("fs", localFs);
  return rewiredModule;
}

function rewireDefaultFsImport(modulePath, overrides) {
  const rewiredModule = rewire(modulePath);
  const fsImport = rewiredModule.__get__("fs_1");
  fsImport.default = Object.assign(Object.create(fsImport.default), overrides);
  return rewiredModule;
}

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

  it("retries transient atomic rename failures", function () {
    const filePath = path.join(tempDir, "daemon.json");
    fs.writeFileSync(filePath, "old");

    let attempts = 0;
    const writeFileAtomicDependency = rewireModuleFs(
      writeFileAtomicModulePath,
      {
        renameSync(oldPath, newPath) {
          attempts++;
          if (attempts === 1) {
            const error = new Error("temporarily busy");
            error.code = "EPERM";
            throw error;
          }
          return fs.renameSync(oldPath, newPath);
        },
      }
    );
    const writeFileAtomicPackage = atomicFileModule.__get__(
      "writeFileAtomicPackage"
    );
    const originalSync = writeFileAtomicPackage.sync;
    writeFileAtomicPackage.sync = writeFileAtomicDependency.sync;

    try {
      writeFileAtomic(filePath, "new");
    } finally {
      writeFileAtomicPackage.sync = originalSync;
    }

    assert.ok(attempts > 1);
    assert.strictEqual(fs.readFileSync(filePath, "utf8"), "new");
  });

  it("keeps the previous file when rename fails", function () {
    const filePath = path.join(tempDir, "daemon.json");
    fs.writeFileSync(filePath, "old");

    let tempFilePath;
    const writeFileAtomicDependency = rewireModuleFs(
      writeFileAtomicModulePath,
      {
        renameSync(oldPath) {
          tempFilePath = oldPath;
          throw new Error("rename failed");
        },
      }
    );
    const writeFileAtomicPackage = atomicFileModule.__get__(
      "writeFileAtomicPackage"
    );
    const originalSync = writeFileAtomicPackage.sync;
    writeFileAtomicPackage.sync = writeFileAtomicDependency.sync;

    try {
      assert.throws(() => writeFileAtomic(filePath, "new"), /rename failed/);
    } finally {
      writeFileAtomicPackage.sync = originalSync;
    }

    assert.strictEqual(fs.readFileSync(filePath, "utf8"), "old");
    assert.strictEqual(fs.existsSync(tempFilePath), false);
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
    const firstOwner = first.readOwner();
    assert.strictEqual(firstOwner.pid, process.pid);
    const [
      tokenPid,
      tokenCreatedAt,
      tokenRandomSuffix,
    ] = firstOwner.token.split("-");
    assert.strictEqual(Number(tokenPid), process.pid);
    assert.strictEqual(Number(tokenCreatedAt), firstOwner.createdAt);
    assert.match(tokenRandomSuffix, /^[0-9a-f]{16}$/);
    assert.strictEqual(second.acquire(), false);

    first.release();
    assert.strictEqual(first.isLocked(), false);
    assert.strictEqual(second.acquire(), true);
    second.release();
  });

  it("uses the injected token factory when acquiring a lock", function () {
    const lockPath = path.join(tempDir, "injected-token.lock");
    const calls = [];
    const lock = new FileLock(lockPath, ({ pid, createdAt }) => {
      calls.push({ pid, createdAt });
      return `test-token-${pid}-${createdAt}`;
    });

    assert.strictEqual(lock.acquire(), true);

    const owner = lock.readOwner();
    assert.deepStrictEqual(calls, [
      {
        pid: owner.pid,
        createdAt: owner.createdAt,
      },
    ]);
    assert.strictEqual(
      owner.token,
      `test-token-${owner.pid}-${owner.createdAt}`
    );

    lock.release();
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

    assert.strictEqual(lock.isLocked(), false);
    assert.strictEqual(fs.existsSync(lockPath), true);
    assert.strictEqual(
      new FileLock(lockPath).readOwner().token,
      "another-owner"
    );
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

    fs.writeFileSync(
      path.join(lockPath, "owner.json"),
      JSON.stringify({
        pid: 1,
        createdAt: Date.now(),
      })
    );
    assert.strictEqual(lock.readOwner(), null);
  });

  it("reports whether the lock owner process is alive", function () {
    const liveLockPath = path.join(tempDir, "live-owner.lock");
    const deadLockPath = path.join(tempDir, "dead-owner.lock");
    const invalidLockPath = path.join(tempDir, "invalid-owner.lock");

    const liveLock = new FileLock(liveLockPath);
    assert.strictEqual(liveLock.acquire(), true);
    assert.strictEqual(liveLock.isLockOwnerAlive(), true);

    fs.mkdirSync(deadLockPath);
    writeLockOwner(deadLockPath, {
      pid: 987654321,
      createdAt: Date.now(),
    });
    assert.strictEqual(new FileLock(deadLockPath).isLockOwnerAlive(), false);

    fs.mkdirSync(invalidLockPath);
    fs.writeFileSync(path.join(invalidLockPath, "owner.json"), "{bad");
    assert.strictEqual(new FileLock(invalidLockPath).isLockOwnerAlive(), false);
    assert.strictEqual(
      new FileLock(path.join(tempDir, "missing.lock")).isLockOwnerAlive(),
      false
    );

    liveLock.release();
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
      pid: 1,
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

  it("uses lock directory mtime when owner metadata is missing", function () {
    const now = Date.now();
    const staleLockPath = path.join(tempDir, "mtime-stale.lock");
    const freshLockPath = path.join(tempDir, "mtime-fresh.lock");

    fs.mkdirSync(staleLockPath);
    fs.mkdirSync(freshLockPath);
    fs.utimesSync(staleLockPath, new Date(now - 5000), new Date(now - 5000));
    fs.utimesSync(freshLockPath, new Date(now), new Date(now));

    assert.strictEqual(
      new FileLock(staleLockPath).cleanupStale(1000, now),
      true
    );
    assert.strictEqual(fs.existsSync(staleLockPath), false);
    assert.strictEqual(
      new FileLock(freshLockPath).cleanupStale(1000, now),
      false
    );
    assert.strictEqual(fs.existsSync(freshLockPath), true);
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

  it("clears local locked state when cleaning a stale lock it owns", function () {
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
    assert.strictEqual(lock.isLocked(), false);
    assert.strictEqual(fs.existsSync(lockPath), false);
  });

  it("try removes locks and clears local state as best effort", function () {
    const liveLockPath = path.join(tempDir, "try-live.lock");
    const localLockPath = path.join(tempDir, "try-local.lock");

    const liveLock = new FileLock(liveLockPath);
    assert.strictEqual(liveLock.acquire(), true);
    const liveOwner = liveLock.readOwner();
    assert.strictEqual(liveLock.tryRemove(liveOwner), true);
    assert.strictEqual(liveLock.isLocked(), false);
    assert.strictEqual(fs.existsSync(liveLockPath), false);
    assert.strictEqual(liveOwner.pid, process.pid);
    assert.strictEqual(typeof liveOwner.token, "string");

    const localLock = new FileLock(localLockPath);
    assert.strictEqual(localLock.acquire(), true);
    assert.strictEqual(localLock.tryRemove(localLock.readOwner()), true);
    assert.strictEqual(localLock.isLocked(), false);
    assert.strictEqual(fs.existsSync(localLockPath), false);

    assert.strictEqual(
      new FileLock(path.join(tempDir, "try-missing.lock")).tryRemove(null),
      false
    );
  });

  it("does not try remove when the expected owner does not match", function () {
    const lockPath = path.join(tempDir, "try-guarded.lock");
    const lock = new FileLock(lockPath);

    assert.strictEqual(lock.acquire(), true);
    assert.strictEqual(lock.tryRemove(null), false);
    assert.strictEqual(lock.isLocked(), true);
    assert.strictEqual(fs.existsSync(lockPath), true);

    lock.release();
  });

  it("treats try remove failures as best effort", function () {
    const lockPath = path.join(tempDir, "try-error.lock");
    fs.mkdirSync(lockPath);

    const rewiredFileLockModule = rewireDefaultFsImport(fileLockModulePath, {
      rmSync() {
        throw new Error("rm failed");
      },
    });
    const RewiredFileLock = rewiredFileLockModule.FileLock;

    assert.strictEqual(new RewiredFileLock(lockPath).tryRemove(null), false);
    assert.strictEqual(fs.existsSync(lockPath), true);
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
        () => new FileLock(lockPath).cleanupStale(1000, Date.now()),
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
        new FileLock(lockPath).cleanupStale(1000, Date.now()),
        false
      );
    } finally {
      fs.existsSync = originalExistsSync;
      fs.statSync = originalStatSync;
    }
  });
});
