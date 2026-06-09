// Copyright 2024 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

const assert = require("assert");
const os = require("os");
const path = require("path");

require("../register_ts");

const {
  createMultiplexerPaths,
  getDefaultMultiplexerRootDir,
  getMultiplexerDaemonLockPath,
  getMultiplexerDataDir,
  getMultiplexerDiscoveryPath,
  getMultiplexerSpawnLockPath,
} = require("../../../../debug_router_connector/src/multiplexer/utils/paths");

describe("multiplexer paths", function () {
  it("uses the connector data directory as default root", function () {
    assert.strictEqual(
      getDefaultMultiplexerRootDir(),
      path.join(os.homedir(), ".DebugRouterConnector")
    );
    assert.strictEqual(
      getMultiplexerDataDir(),
      path.join(os.homedir(), ".DebugRouterConnector", "multiplexer")
    );
  });

  it("creates stable paths under the provided root directory", function () {
    const rootDir = path.join(os.tmpdir(), "debug-router-mux-root");
    const paths = createMultiplexerPaths({ rootDir });

    assert.strictEqual(paths.rootDir, rootDir);
    assert.strictEqual(paths.dataDir, path.join(rootDir, "multiplexer"));
    assert.strictEqual(
      paths.discoveryPath,
      path.join(rootDir, "multiplexer", "daemon.json")
    );
    assert.strictEqual(
      paths.spawnLockPath,
      path.join(rootDir, "multiplexer", "spawn.lock")
    );
    assert.strictEqual(
      paths.daemonLockPath,
      path.join(rootDir, "multiplexer", "daemon.lock")
    );
  });

  it("allows explicit data directory override", function () {
    const rootDir = path.join(os.tmpdir(), "debug-router-mux-root");
    const dataDir = path.join(os.tmpdir(), "debug-router-mux-data");

    assert.strictEqual(getMultiplexerDataDir({ rootDir, dataDir }), dataDir);
    assert.strictEqual(
      getMultiplexerDiscoveryPath({ dataDir }),
      path.join(dataDir, "daemon.json")
    );
    assert.strictEqual(
      getMultiplexerSpawnLockPath({ dataDir }),
      path.join(dataDir, "spawn.lock")
    );
    assert.strictEqual(
      getMultiplexerDaemonLockPath({ dataDir }),
      path.join(dataDir, "daemon.lock")
    );

    assert.deepStrictEqual(createMultiplexerPaths({ rootDir, dataDir }), {
      rootDir,
      dataDir,
      discoveryPath: path.join(dataDir, "daemon.json"),
      spawnLockPath: path.join(dataDir, "spawn.lock"),
      daemonLockPath: path.join(dataDir, "daemon.lock"),
    });
  });

  it("keeps different roots isolated", function () {
    const first = createMultiplexerPaths({
      rootDir: path.join(os.tmpdir(), "debug-router-mux-a"),
    });
    const second = createMultiplexerPaths({
      rootDir: path.join(os.tmpdir(), "debug-router-mux-b"),
    });

    assert.notStrictEqual(first.dataDir, second.dataDir);
    assert.notStrictEqual(first.discoveryPath, second.discoveryPath);
    assert.notStrictEqual(first.spawnLockPath, second.spawnLockPath);
    assert.notStrictEqual(first.daemonLockPath, second.daemonLockPath);
  });
});
