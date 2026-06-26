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

require("../register_ts");

const guardModule = rewire(
  path.join(
    __dirname,
    "../../../../debug_router_connector/src/multiplexer/daemon/LegacyOwnershipGuard"
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

  it("claims the legacy owner file and reports attached status", function () {
    const changes = [];
    const guard = new LegacyOwnershipGuard({
      onStatusChanged: (change) => changes.push(change),
    });

    assert.strictEqual(guard.reacquire(), true);

    assert.strictEqual(
      fs.readFileSync(path.join(ownerDir, "LatestDriverProcess"), "utf8"),
      `${process.pid}`,
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

  it("uses an explicit legacy driver dir instead of the daemon homedir default", function () {
    const explicitDriverDir = path.join(tempDir, "explicit-driver");
    const guard = new LegacyOwnershipGuard({
      legacyDriverDir: explicitDriverDir,
    });

    assert.strictEqual(guard.reacquire(), true);

    assert.strictEqual(
      fs.readFileSync(
        path.join(explicitDriverDir, "LatestDriverProcess"),
        "utf8",
      ),
      `${process.pid}`,
    );
    assert.strictEqual(
      fs.existsSync(path.join(ownerDir, "LatestDriverProcess")),
      false,
    );
  });

  it("clears stale legacy lock dirs before claiming the owner file", function () {
    fs.mkdirSync(lockDir, { recursive: true });
    const guard = new LegacyOwnershipGuard();

    assert.strictEqual(guard.reacquire(), true);

    assert.strictEqual(
      fs.readFileSync(path.join(ownerDir, "LatestDriverProcess"), "utf8"),
      `${process.pid}`,
    );
    assert.strictEqual(fs.existsSync(lockDir), false);
  });

  it("reports unattached when an alive legacy process owns the file", function () {
    const changes = [];
    const guard = new LegacyOwnershipGuard({
      onStatusChanged: (change) => changes.push(change),
    });
    guard.reacquire();
    changes.length = 0;
    fs.writeFileSync(path.join(ownerDir, "LatestDriverProcess"), "90001");
    process.kill = (pid, signal) => {
      assert.strictEqual(pid, 90001);
      assert.strictEqual(signal, 0);
      return true;
    };

    guard.stopped = false;
    guard.monitor();

    assert.deepStrictEqual(changes, [
      {
        status: "unattached",
        ownerPid: process.pid,
        previousOwnerPid: 90001,
        reason: "legacy-preempted",
      },
    ]);
  });

  it("reclaims stale and invalid owner files without reporting preemption", function () {
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
    guard.monitor();
    fs.writeFileSync(path.join(ownerDir, "LatestDriverProcess"), "not-a-pid");
    guard.monitor();

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
      ],
    );
    assert.strictEqual(
      fs.readFileSync(path.join(ownerDir, "LatestDriverProcess"), "utf8"),
      `${process.pid}`,
    );
  });

  it("treats DriverCloseMultiOpen as attached without touching the owner file", function () {
    const changes = [];
    process.env.DriverCloseMultiOpen = "true";
    const guard = new LegacyOwnershipGuard({
      onStatusChanged: (change) => changes.push(change),
    });

    guard.start();
    assert.strictEqual(guard.reacquire(), true);

    assert.deepStrictEqual(
      changes.map((change) => ({
        status: change.status,
        reason: change.reason,
      })),
      [
        {
          status: "attached",
          reason: "daemon-started",
        },
        {
          status: "attached",
          reason: "reacquire-requested",
        },
      ],
    );
    assert.strictEqual(
      fs.existsSync(path.join(ownerDir, "LatestDriverProcess")),
      false,
    );
  });
});
