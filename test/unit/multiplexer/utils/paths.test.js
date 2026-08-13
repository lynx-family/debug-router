// Copyright 2024 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

const assert = require("assert");
const os = require("os");
const path = require("path");

const {
  getDefaultMultiplexerRootDir,
  getMultiplexerControlEndpoint,
  getMultiplexerDataDir,
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
    assert.notStrictEqual(
      getMultiplexerControlEndpoint({ dataDir: firstDir }, "darwin"),
      getMultiplexerControlEndpoint({ dataDir: secondDir }, "darwin")
    );
  });

  it("[v1 compatibility gate] keeps discovery endpoints stable", function () {
    assert.strictEqual(
      getMultiplexerControlEndpoint(
        { dataDir: "/Users/test/.Debug Router/mux_1" },
        "darwin"
      ),
      "/Users/test/.Debug Router/mux_1/control.sock"
    );
    assert.strictEqual(
      getMultiplexerControlEndpoint(
        { dataDir: "C:\\Users\\tester\\mux" },
        "win32"
      ),
      "\\\\.\\pipe\\C:\\Users\\tester\\mux"
    );
  });
});
