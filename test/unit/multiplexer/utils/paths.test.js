// Copyright 2024 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

const assert = require("assert");
const os = require("os");
const path = require("path");

const {
  createMultiplexerPaths,
  getDefaultMultiplexerRootDir,
  getMultiplexerControlEndpoint,
  getMultiplexerDaemonLockPath,
  getMultiplexerDataDir,
  getMultiplexerSpawnLockPath,
} = require("../../../../debug_router_connector/dist/cjs/src/multiplexer/utils/paths");

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

  it("creates a fixed Unix endpoint and lock paths", function () {
    const rootDir = path.join(os.tmpdir(), "debug-router-mux-root");
    const paths = createMultiplexerPaths({ rootDir });
    assert.strictEqual(paths.rootDir, rootDir);
    assert.strictEqual(paths.dataDir, path.join(rootDir, "multiplexer"));
    if (process.platform !== "win32") {
      assert.strictEqual(
        paths.controlEndpoint,
        path.join(rootDir, "multiplexer", "control.sock")
      );
    }
    assert.strictEqual(
      paths.spawnLockPath,
      path.join(rootDir, "multiplexer", "spawn.lock")
    );
    assert.strictEqual(
      paths.daemonLockPath,
      path.join(rootDir, "multiplexer", "daemon.lock")
    );
    assert.strictEqual(Object.hasOwn(paths, "discoveryPath"), false);
  });

  it("derives the Windows named pipe from the custom data directory", function () {
    const endpoint = getMultiplexerControlEndpoint(
      { dataDir: "C:\\Users\\tester\\mux" },
      "win32"
    );
    assert.strictEqual(endpoint, "\\\\.\\pipe\\C:\\Users\\tester\\mux");
    assert.strictEqual(
      getMultiplexerControlEndpoint(
        { dataDir: "D:\\another\\directory" },
        "win32"
      ),
      "\\\\.\\pipe\\D:\\another\\directory"
    );
  });

  it("uses control.sock directly even for a long Unix data directory", function () {
    const dataDir = path.join(os.tmpdir(), "x".repeat(180));
    assert.strictEqual(
      getMultiplexerControlEndpoint({ dataDir }, "darwin"),
      path.join(dataDir, "control.sock")
    );
  });

  it("allows explicit data directory override and isolates endpoints", function () {
    const firstDir = path.join(os.tmpdir(), "debug-router-mux-a");
    const secondDir = path.join(os.tmpdir(), "debug-router-mux-b");
    assert.strictEqual(getMultiplexerDataDir({ dataDir: firstDir }), firstDir);
    assert.strictEqual(
      getMultiplexerSpawnLockPath({ dataDir: firstDir }),
      path.join(firstDir, "spawn.lock")
    );
    assert.strictEqual(
      getMultiplexerDaemonLockPath({ dataDir: firstDir }),
      path.join(firstDir, "daemon.lock")
    );
    assert.notStrictEqual(
      getMultiplexerControlEndpoint({ dataDir: firstDir }, "darwin"),
      getMultiplexerControlEndpoint({ dataDir: secondDir }, "darwin")
    );
  });
});
