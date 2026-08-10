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

const entryModule = rewire(
  path.join(
    __dirname,
    "../../../../debug_router_connector/dist/cjs/src/multiplexer/daemon/entry"
  )
);
const {
  createMultiplexerDaemon,
  parseEntryOption,
  startMultiplexerDaemonEntry,
} = entryModule;
const {
  DriverReportServiceImpl,
} = require("../../../../debug_router_connector/dist/cjs/src/report/interface/DriverReportServiceImpl");
const {
  getDriverReportService,
  setDriverReportService,
} = require("../../../../debug_router_connector/dist/cjs/src/report/interface/DriverReportService");

class FakeEntryHost {
  static instances = [];
  static startError = null;

  constructor(option) {
    this.option = option;
    this.startCalls = [];
    this.stopCalls = 0;
    FakeEntryHost.instances.push(this);
  }
  async start(option) {
    this.startCalls.push(option);
    if (FakeEntryHost.startError) throw FakeEntryHost.startError;
  }
  async stop() {
    this.stopCalls++;
  }
  setIdleTimeoutHandler(handler) {
    this.idleHandler = handler;
  }
  setShutdownHandler(handler) {
    this.shutdownHandler = handler;
  }
}

function replaceEntryHostCtor() {
  const hostImport = entryModule.__get__("MultiplexerHost_1");
  const original = hostImport.MultiplexerHost;
  hostImport.MultiplexerHost = FakeEntryHost;
  return () => (hostImport.MultiplexerHost = original);
}

function createOption(tempDir, overrides = {}) {
  return {
    controlEndpoint:
      overrides.controlEndpoint ?? path.join(tempDir, "control.sock"),
    daemonLockPath:
      overrides.daemonLockPath ?? path.join(tempDir, "daemon.lock"),
    protocolVersion: overrides.protocolVersion ?? 1,
    minSupportedProtocolVersion: overrides.minSupportedProtocolVersion ?? 1,
    ...overrides,
  };
}

function stubProcessOnce() {
  const original = process.once;
  const registrations = [];
  process.once = (event, handler) => {
    registrations.push({ event, handler });
    return process;
  };
  return {
    registrations,
    restore() {
      process.once = original;
    },
  };
}

describe("multiplexer daemon entry", function () {
  let tempDir;

  beforeEach(function () {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "debug-router-entry-"));
    FakeEntryHost.instances = [];
    FakeEntryHost.startError = null;
  });

  afterEach(function () {
    setDriverReportService(null);
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("parses fixed endpoint options and protocol defaults", function () {
    assert.deepStrictEqual(
      parseEntryOption([
        "--control-endpoint",
        "/tmp/control.sock",
        "--daemon-lock-path",
        "/tmp/daemon.lock",
        "--debug-info",
        '{"daemonVersion":"1.2.3"}',
      ]),
      {
        controlEndpoint: "/tmp/control.sock",
        daemonLockPath: "/tmp/daemon.lock",
        protocolVersion: 1,
        minSupportedProtocolVersion: 1,
        debugInfo: { daemonVersion: "1.2.3" },
      }
    );
  });

  it("parses camelCase, equals-style, and optional daemon settings", function () {
    const option = parseEntryOption([
      "--controlEndpoint=/tmp/control.sock",
      "--daemonLockPath=/tmp/daemon.lock",
      "--protocolVersion=2",
      "--minSupportedProtocolVersion=2",
      "--legacyDriverDir=/tmp/legacy",
      "--multiplexerDaemonIdleTimeout=50",
      "--enableWebSocket=true",
      "--websocketPort=9444",
      "--websocketRoomId=room",
      '--connectionTrace={"enabled":true,"output":"/tmp/trace"}',
      '--physicalConnectorOption={"enableAndroid":true}',
    ]);
    assert.deepStrictEqual(option, {
      controlEndpoint: "/tmp/control.sock",
      daemonLockPath: "/tmp/daemon.lock",
      protocolVersion: 2,
      minSupportedProtocolVersion: 2,
      legacyDriverDir: "/tmp/legacy",
      multiplexerDaemonIdleTimeout: 50,
      enableWebSocket: true,
      websocketOption: { port: 9444, roomId: "room" },
      connectionTrace: { enabled: true, output: "/tmp/trace" },
      physicalConnectorOption: { enableAndroid: true },
    });
  });

  it("rejects removed discovery/port/heartbeat args and missing endpoint", function () {
    assert.throws(
      () =>
        parseEntryOption([
          "--discovery-path=/tmp/daemon.json",
          "--daemon-lock-path=/tmp/daemon.lock",
        ]),
      /Unknown multiplexer daemon option: discovery-path/
    );
    assert.throws(
      () =>
        parseEntryOption([
          "--control-endpoint=/tmp/control.sock",
          "--daemon-lock-path=/tmp/daemon.lock",
          "--control-port=9000",
        ]),
      /Unknown multiplexer daemon option: control-port/
    );
    assert.throws(
      () => parseEntryOption(["--daemon-lock-path=/tmp/daemon.lock"]),
      /Missing required multiplexer daemon option: controlEndpoint/
    );
  });

  it("rejects malformed JSON and invalid scalar options", function () {
    const base = [
      "--control-endpoint=/tmp/control.sock",
      "--daemon-lock-path=/tmp/daemon.lock",
    ];
    assert.throws(
      () => parseEntryOption([...base, "--debug-info={"]),
      /Invalid multiplexer daemon option debugInfo/
    );
    assert.throws(
      () => parseEntryOption([...base, "--enable-websocket=maybe"]),
      /Invalid multiplexer daemon option enableWebSocket/
    );
    assert.throws(
      () => parseEntryOption([...base, "--protocol-version=bad"]),
      /Invalid multiplexer daemon option protocolVersion/
    );
  });

  it("constructs Host with endpoint and omits daemon discovery state", async function () {
    const restore = replaceEntryHostCtor();
    try {
      const option = createOption(tempDir, {
        protocolVersion: 3,
        minSupportedProtocolVersion: 2,
        debugInfo: { daemonVersion: "3" },
        enableWebSocket: true,
        physicalConnectorOption: { enableAndroid: true },
      });
      const daemon = createMultiplexerDaemon(option);
      assert.deepStrictEqual(FakeEntryHost.instances[0].option, {
        controlEndpoint: option.controlEndpoint,
        protocolVersion: 3,
        minSupportedProtocolVersion: 2,
        debugInfo: { daemonVersion: "3" },
        enableWebSocket: true,
        enableAndroid: true,
      });
      assert(getDriverReportService() instanceof DriverReportServiceImpl);
      await daemon.start();
      assert.strictEqual(fs.existsSync(option.daemonLockPath), true);
      assert.strictEqual(
        fs.existsSync(path.join(tempDir, "daemon.json")),
        false
      );
      await daemon.stop();
    } finally {
      restore();
    }
  });

  it("registers cleanup handlers before starting and cleans on beforeExit", async function () {
    const restoreHost = replaceEntryHostCtor();
    const processOnce = stubProcessOnce();
    try {
      const option = createOption(tempDir);
      const daemon = await startMultiplexerDaemonEntry([
        "--control-endpoint",
        option.controlEndpoint,
        "--daemon-lock-path",
        option.daemonLockPath,
      ]);
      assert.strictEqual(FakeEntryHost.instances[0].startCalls.length, 1);
      assert.deepStrictEqual(
        processOnce.registrations.map((entry) => entry.event),
        [
          "beforeExit",
          "SIGINT",
          "SIGTERM",
          "uncaughtException",
          "unhandledRejection",
        ]
      );
      processOnce.registrations
        .find((entry) => entry.event === "beforeExit")
        .handler();
      await new Promise((resolve) => setImmediate(resolve));
      assert.strictEqual(FakeEntryHost.instances[0].stopCalls, 1);
      await daemon.stop();
    } finally {
      processOnce.restore();
      restoreHost();
    }
  });

  it("cleans daemon.lock when Host start fails", async function () {
    const restoreHost = replaceEntryHostCtor();
    const processOnce = stubProcessOnce();
    FakeEntryHost.startError = new Error("entry host failed");
    try {
      const option = createOption(tempDir);
      await assert.rejects(
        () =>
          startMultiplexerDaemonEntry([
            "--control-endpoint",
            option.controlEndpoint,
            "--daemon-lock-path",
            option.daemonLockPath,
          ]),
        /entry host failed/
      );
      assert.strictEqual(fs.existsSync(option.daemonLockPath), false);
    } finally {
      processOnce.restore();
      restoreHost();
    }
  });
});
