// Copyright 2024 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

require("../register_ts");

const {
  createMultiplexerDaemon,
  parseEntryOption,
} = require("../../../../debug_router_connector/src/multiplexer/daemon/entry");

function createTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "debug-router-mux-entry-"));
}

describe("multiplexer daemon entry", function () {
  let tempDir;

  beforeEach(function () {
    tempDir = createTempDir();
  });

  afterEach(function () {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("parses hyphenated options, defaults, and capabilities", function () {
    assert.deepStrictEqual(
      parseEntryOption([
        "--discovery-path",
        "/tmp/daemon.json",
        "--daemon-lock-path",
        "/tmp/daemon.lock",
        "--capabilities",
        "control, snapshot ,, routing",
      ]),
      {
        discoveryPath: "/tmp/daemon.json",
        daemonLockPath: "/tmp/daemon.lock",
        protocolVersion: 1,
        minSupportedProtocolVersion: 1,
        controlPort: 0,
        heartbeatInterval: 1000,
        daemonVersion: undefined,
        capabilities: ["control", "snapshot", "routing"],
      }
    );
  });

  it("parses camelCase options and equals-style values", function () {
    assert.deepStrictEqual(
      parseEntryOption([
        "--discoveryPath=/tmp/daemon.json",
        "--daemonLockPath=/tmp/daemon.lock",
        "--protocolVersion=2",
        "--minSupportedProtocolVersion=2",
        "--controlPort=9222",
        "--heartbeatInterval=200",
        "--daemonVersion=1.2.3",
      ]),
      {
        discoveryPath: "/tmp/daemon.json",
        daemonLockPath: "/tmp/daemon.lock",
        protocolVersion: 2,
        minSupportedProtocolVersion: 2,
        controlPort: 9222,
        heartbeatInterval: 200,
        daemonVersion: "1.2.3",
        capabilities: undefined,
      }
    );
  });

  it("rejects missing required options", function () {
    assert.throws(
      () => parseEntryOption(["--discovery-path", "/tmp/daemon.json"]),
      /Missing required multiplexer daemon option: daemonLockPath/
    );
    assert.throws(
      () => parseEntryOption(["--daemon-lock-path", "/tmp/daemon.lock"]),
      /Missing required multiplexer daemon option: discoveryPath/
    );
  });

  it("rejects unknown, positional, and valueless numeric options", function () {
    assert.throws(
      () =>
        parseEntryOption([
          "--discovery-path",
          "/tmp/daemon.json",
          "--daemon-lock-path",
          "/tmp/daemon.lock",
          "--unknown",
          "x",
        ]),
      /Unknown multiplexer daemon option: unknown/
    );
    assert.throws(() => parseEntryOption(["positional"]), /Unexpected/);
    assert.throws(
      () =>
        parseEntryOption([
          "--discovery-path",
          "/tmp/daemon.json",
          "--daemon-lock-path",
          "/tmp/daemon.lock",
          "--control-port",
        ]),
      /Invalid multiplexer daemon option controlPort/
    );
  });

  it("creates a daemon with entry host discovery fields", function () {
    const discoveryPath = path.join(tempDir, "daemon.json");
    const daemonLockPath = path.join(tempDir, "daemon.lock");
    const daemon = createMultiplexerDaemon({
      discoveryPath,
      daemonLockPath,
      protocolVersion: 1,
      minSupportedProtocolVersion: 1,
      controlPort: 9333,
      heartbeatInterval: 100000,
    });

    const info = daemon.createDiscoveryInfo();
    assert.strictEqual(info.controlPort, 9333);
    assert.strictEqual(info.protocolVersion, 1);
    assert.strictEqual(info.minSupportedProtocolVersion, 1);
    assert.strictEqual(fs.existsSync(discoveryPath), false);
  });
});
