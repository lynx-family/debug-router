// Copyright 2024 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const rewire = require(require.resolve("rewire", {
  paths: [path.join(__dirname, "../../../../debug_router_connector")],
}));

const guardModule = rewire(
  path.join(
    __dirname,
    "../../../../debug_router_connector/dist/cjs/src/multiplexer/daemon/LegacyOwnershipGuard"
  )
);
const { LegacyOwnershipGuard } = guardModule;

describe("LegacyOwnershipGuard", function () {
  let tempDir;
  let ownerDir;
  let lockDir;
  let restoreFileLock;
  let originalProcessKill;
  let originalDriverCloseMultiOpen;

  beforeEach(function () {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "legacy-owner-"));
    ownerDir = path.join(tempDir, "driver");
    lockDir = path.join(ownerDir, "lockfile");
    fs.mkdirSync(ownerDir, { recursive: true });
    const fileLockImport = guardModule.__get__("file_lock_1");
    const originalDriverDir = fileLockImport.driver_dir;
    const originalLockDir = fileLockImport.lockDir;
    fileLockImport.driver_dir = ownerDir;
    fileLockImport.lockDir = lockDir;
    restoreFileLock = () => {
      fileLockImport.driver_dir = originalDriverDir;
      fileLockImport.lockDir = originalLockDir;
    };
    originalProcessKill = process.kill;
    originalDriverCloseMultiOpen = process.env.DriverCloseMultiOpen;
    delete process.env.DriverCloseMultiOpen;
  });

  afterEach(function () {
    restoreFileLock?.();
    process.kill = originalProcessKill;
    if (originalDriverCloseMultiOpen === undefined) {
      delete process.env.DriverCloseMultiOpen;
    } else {
      process.env.DriverCloseMultiOpen = originalDriverCloseMultiOpen;
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("claims the legacy owner file and reports attached status", async function () {
    const changes = [];
    const guard = new LegacyOwnershipGuard({
      onStatusChanged: (change) => changes.push(change),
    });

    assert.strictEqual(await guard.reacquire(), true);

    assert.strictEqual(
      fs.readFileSync(path.join(ownerDir, "LatestDriverProcess"), "utf8"),
      `${process.pid}`
    );
    assert.deepStrictEqual(changes, [
      {
        status: "attached",
        ownerPid: process.pid,
        previousOwnerPid: undefined,
        reason: "reacquire-requested",
      },
    ]);
  });

  it("uses an explicit legacy driver dir instead of the daemon homedir default", async function () {
    const explicitDriverDir = path.join(tempDir, "explicit-driver");
    fs.mkdirSync(explicitDriverDir, { recursive: true });
    const guard = new LegacyOwnershipGuard({
      legacyDriverDir: explicitDriverDir,
    });

    assert.strictEqual(await guard.reacquire(), true);

    assert.strictEqual(
      fs.readFileSync(
        path.join(explicitDriverDir, "LatestDriverProcess"),
        "utf8"
      ),
      `${process.pid}`
    );
    assert.strictEqual(
      fs.existsSync(path.join(ownerDir, "LatestDriverProcess")),
      false
    );
  });

  it("retries lock acquisition until the legacy lock holder releases", async function () {
    fs.mkdirSync(lockDir, { recursive: true });
    const guard = new LegacyOwnershipGuard();
    setTimeout(() => fs.rmdirSync(lockDir), 20);

    assert.strictEqual(await guard.reacquire(), true);

    assert.strictEqual(
      fs.readFileSync(path.join(ownerDir, "LatestDriverProcess"), "utf8"),
      `${process.pid}`
    );
    assert.strictEqual(fs.existsSync(lockDir), false);
  });

  it("removes a legacy lock that remains held after all attempts", async function () {
    fs.mkdirSync(lockDir, { recursive: true });
    const guard = new LegacyOwnershipGuard();

    assert.strictEqual(await guard.reacquire(), true);

    assert.strictEqual(fs.existsSync(lockDir), false);
    assert.strictEqual(
      fs.readFileSync(path.join(ownerDir, "LatestDriverProcess"), "utf8"),
      `${process.pid}`
    );
  });

  it("does not start monitoring after being stopped while acquiring the lock", async function () {
    fs.mkdirSync(lockDir, { recursive: true });
    const guard = new LegacyOwnershipGuard();

    const startPromise = guard.start();
    guard.stop();
    fs.rmdirSync(lockDir);
    await startPromise;

    assert.strictEqual(guard.stopped, true);
    assert.strictEqual(guard.monitorTimer, undefined);
  });

  it("prepares the legacy driver dir when the guard starts", async function () {
    const explicitDriverDir = path.join(tempDir, "start-driver");
    const guard = new LegacyOwnershipGuard({
      legacyDriverDir: explicitDriverDir,
    });

    await guard.start();
    guard.stop();

    assert.strictEqual(
      fs.readFileSync(
        path.join(explicitDriverDir, "LatestDriverProcess"),
        "utf8"
      ),
      `${process.pid}`
    );
  });

  it("reports unattached when an alive legacy process owns the file", async function () {
    const changes = [];
    const guard = new LegacyOwnershipGuard({
      onStatusChanged: (change) => changes.push(change),
    });
    await guard.reacquire();
    changes.length = 0;
    fs.writeFileSync(path.join(ownerDir, "LatestDriverProcess"), "90001");
    process.kill = (pid, signal) => {
      assert.strictEqual(pid, 90001);
      assert.strictEqual(signal, 0);
      return true;
    };

    guard.stopped = false;
    await guard.monitor();

    assert.deepStrictEqual(changes, [
      {
        status: "unattached",
        ownerPid: process.pid,
        previousOwnerPid: 90001,
        reason: "legacy-preempted",
      },
    ]);
  });

  it("reclaims stale and invalid owner files without reporting preemption", async function () {
    const changes = [];
    const guard = new LegacyOwnershipGuard({
      onStatusChanged: (change) => changes.push(change),
    });
    fs.mkdirSync(ownerDir, { recursive: true });
    fs.writeFileSync(path.join(ownerDir, "LatestDriverProcess"), "90002");
    process.kill = () => {
      const error = new Error("missing");
      error.code = "ESRCH";
      throw error;
    };

    guard.stopped = false;
    await guard.monitor();
    fs.writeFileSync(path.join(ownerDir, "LatestDriverProcess"), "not-a-pid");
    await guard.monitor();

    assert.deepStrictEqual(
      changes.map((change) => ({
        status: change.status,
        previousOwnerPid: change.previousOwnerPid,
        reason: change.reason,
      })),
      [
        {
          status: "attached",
          previousOwnerPid: 90002,
          reason: "stale-owner",
        },
        {
          status: "attached",
          previousOwnerPid: undefined,
          reason: "invalid-owner",
        },
      ]
    );
    assert.strictEqual(
      fs.readFileSync(path.join(ownerDir, "LatestDriverProcess"), "utf8"),
      `${process.pid}`
    );
  });

  it("disables ownership handling by silently attaching without touching the owner file", async function () {
    const changes = [];
    process.env.DriverCloseMultiOpen = "true";
    const guard = new LegacyOwnershipGuard({
      onStatusChanged: (change) => changes.push(change),
    });

    assert.strictEqual(await guard.reacquire(), true);
    assert.strictEqual(guard.currentStatus, "unInit");
    await guard.start();
    assert.strictEqual(await guard.reacquire(), true);

    assert.strictEqual(guard.currentStatus, "attached");
    assert.deepStrictEqual(changes, []);
    assert.strictEqual(guard.monitorTimer, undefined);
    assert.strictEqual(
      fs.existsSync(path.join(ownerDir, "LatestDriverProcess")),
      false
    );
  });
});
