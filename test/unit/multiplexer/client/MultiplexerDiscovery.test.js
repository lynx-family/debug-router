// Copyright 2024 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

require("../register_ts");

const {
  MultiplexerDiscovery,
} = require("../../../../debug_router_connector/src/multiplexer/client/MultiplexerDiscovery");

function createTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "debug-router-mux-discovery-"));
}

function createInfo(overrides = {}) {
  return {
    pid: 100,
    protocolVersion: 1,
    controlPort: 9000,
    heartbeat: 1000,
    startedAt: 900,
    daemonVersion: "0.0.1",
    capabilities: ["discovery"],
    ...overrides,
  };
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value));
}

describe("MultiplexerDiscovery", function () {
  let tempDir;
  let discoveryPath;
  let now;
  let discovery;

  beforeEach(function () {
    tempDir = createTempDir();
    discoveryPath = path.join(tempDir, "daemon.json");
    now = 1000;
    discovery = new MultiplexerDiscovery({
      discoveryPath,
      localProtocolVersion: 1,
      staleTimeout: 500,
      now: () => now,
    });
  });

  afterEach(function () {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("returns missing for absent discovery", function () {
    assert.deepStrictEqual(discovery.validateDiscovery(), {
      status: "unusable",
      reason: "missing",
    });
    assert.strictEqual(discovery.readDiscovery(), null);
    assert.strictEqual(discovery.getFreshDiscovery(), null);
    assert.strictEqual(discovery.getReusableDiscovery(), null);
  });

  it("returns invalid-json for malformed discovery", function () {
    fs.writeFileSync(discoveryPath, "{bad");

    assert.deepStrictEqual(discovery.validateDiscovery(), {
      status: "unusable",
      reason: "invalid-json",
    });
    assert.strictEqual(discovery.readDiscovery(), null);
  });

  it("returns invalid-shape for non-object and incomplete object values", function () {
    fs.writeFileSync(discoveryPath, "null");
    assert.deepStrictEqual(discovery.validateDiscovery(), {
      status: "unusable",
      reason: "invalid-shape",
    });

    writeJson(discoveryPath, {
      pid: 100,
      protocolVersion: 1,
      heartbeat: 1000,
    });
    assert.deepStrictEqual(discovery.validateDiscovery(), {
      status: "unusable",
      reason: "invalid-shape",
    });
  });

  it("returns missing-protocol-version before generic shape errors", function () {
    writeJson(discoveryPath, {
      pid: 100,
      controlPort: 9000,
      heartbeat: 1000,
    });

    assert.deepStrictEqual(discovery.validateDiscovery(), {
      status: "unusable",
      reason: "missing-protocol-version",
    });
  });

  it("returns stale for old heartbeat and includes the stale info", function () {
    now = 2000;
    const staleInfo = createInfo({ heartbeat: 1000 });
    writeJson(discoveryPath, staleInfo);

    assert.deepStrictEqual(discovery.validateDiscovery(), {
      status: "unusable",
      reason: "stale",
      info: staleInfo,
    });
    assert.strictEqual(discovery.isFresh(staleInfo), false);
  });

  it("accepts the same protocol version as usable", function () {
    const info = createInfo();
    writeJson(discoveryPath, info);

    assert.deepStrictEqual(discovery.validateDiscovery(), {
      status: "usable",
      info,
      compatibility: {
        status: "compatible",
        reason: "same-version",
        daemonProtocolVersion: 1,
        connectorProtocolVersion: 1,
      },
    });
    assert.deepStrictEqual(discovery.readDiscovery(), info);
    assert.deepStrictEqual(discovery.getFreshDiscovery(), info);
    assert.deepStrictEqual(discovery.getReusableDiscovery(), info);
  });

  it("accepts a newer daemon protocol as compatible", function () {
    const info = createInfo({
      protocolVersion: 2,
      minSupportedProtocolVersion: 1,
    });
    writeJson(discoveryPath, info);

    assert.deepStrictEqual(discovery.validateDiscovery(), {
      status: "usable",
      info,
      compatibility: {
        status: "compatible",
        reason: "daemon-newer-compatible",
        daemonProtocolVersion: 2,
        connectorProtocolVersion: 1,
      },
    });
  });

  it("rejects a newer daemon when connector protocol is too old", function () {
    const info = createInfo({
      protocolVersion: 2,
      minSupportedProtocolVersion: 2,
    });
    writeJson(discoveryPath, info);

    assert.deepStrictEqual(discovery.validateDiscovery(), {
      status: "unusable",
      reason: "connector-protocol-too-old",
      info,
      compatibility: {
        status: "incompatible",
        reason: "connector-older-than-daemon-min-supported",
        daemonProtocolVersion: 2,
        daemonMinSupportedProtocolVersion: 2,
        connectorProtocolVersion: 1,
      },
    });
    assert.strictEqual(discovery.getFreshDiscovery(), null);
    assert.strictEqual(discovery.getReusableDiscovery(), null);
  });

  it("requires replacement for an older daemon protocol", function () {
    const info = createInfo({ protocolVersion: 0 });
    writeJson(discoveryPath, info);

    assert.deepStrictEqual(discovery.validateDiscovery(), {
      status: "replace-required",
      info,
      compatibility: {
        status: "replace-required",
        reason: "daemon-older-than-connector",
        daemonProtocolVersion: 0,
        connectorProtocolVersion: 1,
      },
    });
    assert.strictEqual(discovery.getFreshDiscovery(), null);
    assert.strictEqual(discovery.getReusableDiscovery(), null);
  });

  it("validates explicitly provided info without reading the file", function () {
    const info = createInfo();

    assert.deepStrictEqual(discovery.validateDiscovery(info).status, "usable");
    assert.deepStrictEqual(discovery.validateDiscovery(null), {
      status: "unusable",
      reason: "missing",
    });
  });
});
