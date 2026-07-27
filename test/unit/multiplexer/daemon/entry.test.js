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

const entryModule = rewire(
  path.join(
    __dirname,
    "../../../../debug_router_connector/src/multiplexer/daemon/entry"
  )
);
const {
  createMultiplexerDaemon,
  parseEntryOption,
  startMultiplexerDaemonEntry,
} = entryModule;
const {
  MultiplexerHost,
} = require("../../../../debug_router_connector/src/multiplexer/daemon/MultiplexerHost");
const {
  defaultLogger,
} = require("../../../../debug_router_connector/src/utils/logger");
const {
  DriverReportServiceImpl,
} = require("../../../../debug_router_connector/src/report/interface/DriverReportServiceImpl");
const {
  getDriverReportService,
  setDriverReportService,
} = require("../../../../debug_router_connector/src/report/interface/DriverReportService");

function createTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "debug-router-mux-entry-"));
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function assertDefaultReportServiceInstalled() {
  const reportService = getDriverReportService();
  assert(reportService instanceof DriverReportServiceImpl);
  reportService.init(false);
  reportService.report("test", null, null);
}

function nextTick() {
  return new Promise((resolve) => setImmediate(resolve));
}

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
    if (FakeEntryHost.startError) {
      throw FakeEntryHost.startError;
    }
  }

  async stop() {
    this.stopCalls++;
  }

  getControlPort() {
    return this.option.controlPort > 0 ? this.option.controlPort : 9123;
  }
}

class FakeStopFailHost extends FakeEntryHost {
  async stop() {
    this.stopCalls++;
    throw new Error("entry host stop failed");
  }
}

function resetFakeEntryHost() {
  FakeEntryHost.instances = [];
  FakeEntryHost.startError = null;
}

function replaceEntryHostCtor(Ctor = FakeEntryHost) {
  const hostImport = entryModule.__get__("MultiplexerHost_1");
  const originalHost = hostImport.MultiplexerHost;
  hostImport.MultiplexerHost = Ctor;

  return () => {
    hostImport.MultiplexerHost = originalHost;
  };
}

function createEntryOption(overrides = {}) {
  const option = {
    discoveryPath: overrides.discoveryPath ?? "/tmp/daemon.json",
    daemonLockPath: overrides.daemonLockPath ?? "/tmp/daemon.lock",
    protocolVersion: overrides.protocolVersion ?? 1,
    minSupportedProtocolVersion: overrides.minSupportedProtocolVersion ?? 1,
    controlPort: overrides.controlPort ?? 0,
    heartbeatInterval: overrides.heartbeatInterval ?? 100000,
    debugInfo: overrides.debugInfo,
    physicalConnectorOption: overrides.physicalConnectorOption,
  };
  if (overrides.legacyDriverDir !== undefined) {
    option.legacyDriverDir = overrides.legacyDriverDir;
  }
  return option;
}

function stubProcessOnce() {
  const originalOnce = process.once;
  const registrations = [];

  process.once = (event, handler) => {
    registrations.push({ event, handler });
    return process;
  };

  return {
    registrations,
    restore() {
      process.once = originalOnce;
    },
  };
}

describe("multiplexer daemon entry", function () {
  let tempDir;

  beforeEach(function () {
    tempDir = createTempDir();
    defaultLogger.setOutput(() => {});
  });

  afterEach(function () {
    setDriverReportService(null);
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("parses hyphenated options, defaults, and debug info", function () {
    assert.deepStrictEqual(
      parseEntryOption([
        "--discovery-path",
        "/tmp/daemon.json",
        "--daemon-lock-path",
        "/tmp/daemon.lock",
        "--debug-info",
        '{"daemonVersion":"1.2.3"}',
      ]),
      {
        discoveryPath: "/tmp/daemon.json",
        daemonLockPath: "/tmp/daemon.lock",
        protocolVersion: 1,
        minSupportedProtocolVersion: 1,
        controlPort: 0,
        heartbeatInterval: 1000,
        debugInfo: {
          daemonVersion: "1.2.3",
        },
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
        '--debugInfo={"daemonVersion":"1.2.3"}',
      ]),
      {
        discoveryPath: "/tmp/daemon.json",
        daemonLockPath: "/tmp/daemon.lock",
        protocolVersion: 2,
        minSupportedProtocolVersion: 2,
        controlPort: 9222,
        heartbeatInterval: 200,
        debugInfo: {
          daemonVersion: "1.2.3",
        },
      }
    );
  });

  it("parses legacy driver dir for daemon-side multi-open ownership", function () {
    assert.deepStrictEqual(
      parseEntryOption([
        "--discovery-path",
        "/tmp/daemon.json",
        "--daemon-lock-path",
        "/tmp/daemon.lock",
        "--legacy-driver-dir",
        "/tmp/legacy-driver",
      ]).legacyDriverDir,
      "/tmp/legacy-driver"
    );
  });

  it("rejects invalid debug info", function () {
    assert.throws(
      () => parseEntryOption([
        "--discovery-path=/tmp/daemon.json",
        "--daemon-lock-path=/tmp/daemon.lock",
        "--debug-info=",
      ]),
      /Invalid multiplexer daemon option debugInfo/
    );
  });

  it("parses physical connector options from JSON", function () {
    const parsed = parseEntryOption([
      "--discovery-path",
      "/tmp/daemon.json",
      "--daemon-lock-path",
      "/tmp/daemon.lock",
      "--physical-connector-option",
      JSON.stringify({
        manualConnect: true,
        enableAndroid: true,
        enableIOS: false,
        enableHarmony: false,
        adbHostPort: {
          host: "127.0.0.1",
          port: 5037,
        },
        usbConnectOpt: {
          retryTime: 5000,
        },
        connectionTrace: {
          enabled: true,
          output: "/tmp/connection-trace.ndjson",
          bufferSize: 100,
        },
      }),
    ]);

    assert.deepStrictEqual(parsed.physicalConnectorOption, {
      manualConnect: true,
      enableAndroid: true,
      enableIOS: false,
      enableHarmony: false,
      adbHostPort: {
        host: "127.0.0.1",
        port: 5037,
      },
      usbConnectOpt: {
        retryTime: 5000,
      },
      connectionTrace: {
        enabled: true,
        output: "/tmp/connection-trace.ndjson",
        bufferSize: 100,
      },
    });
  });

  it("rejects malformed physical connector options", function () {
    assert.throws(
      () =>
        parseEntryOption([
          "--discovery-path",
          "/tmp/daemon.json",
          "--daemon-lock-path",
          "/tmp/daemon.lock",
          "--physical-connector-option",
          "{bad-json",
        ]),
      /Invalid multiplexer daemon option physicalConnectorOption/
    );
    assert.throws(
      () =>
        parseEntryOption([
          "--discovery-path",
          "/tmp/daemon.json",
          "--daemon-lock-path",
          "/tmp/daemon.lock",
          "--physical-connector-option",
          "[]",
        ]),
      /expected object/
    );
    for (const invalidOption of [
      { connectionTrace: null },
      { connectionTrace: { enabled: "true" } },
      { connectionTrace: { output: { stream: true } } },
      { connectionTrace: { bufferSize: -1 } },
      { traceRecorder: {} },
      { reportService: {} },
    ]) {
      assert.throws(
        () =>
          parseEntryOption([
            "--discovery-path",
            "/tmp/daemon.json",
            "--daemon-lock-path",
            "/tmp/daemon.lock",
            "--physical-connector-option",
            JSON.stringify(invalidOption),
          ]),
        /Invalid multiplexer daemon option physicalConnectorOption/
      );
    }
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
    assert.throws(
      () =>
        parseEntryOption([
          "--discovery-path=",
          "--daemon-lock-path",
          "/tmp/daemon.lock",
        ]),
      /Missing required multiplexer daemon option: discoveryPath/
    );
    assert.throws(
      () =>
        parseEntryOption([
          "--discovery-path",
          "/tmp/daemon.json",
          "--daemon-lock-path",
          "/tmp/daemon.lock",
          "--heartbeat-interval",
          "NaN",
        ]),
      /Invalid multiplexer daemon option heartbeatInterval/
    );
  });

  it("creates a daemon with entry host discovery fields", function () {
    const discoveryPath = path.join(tempDir, "daemon.json");
    const daemonLockPath = path.join(tempDir, "daemon.lock");
    const daemon = createMultiplexerDaemon({
      discoveryPath,
      daemonLockPath,
      protocolVersion: 3,
      minSupportedProtocolVersion: 2,
      controlPort: 9333,
      heartbeatInterval: 100000,
      debugInfo: {
        daemonVersion: "0.0.3",
      },
    });

    const info = daemon.createDiscoveryInfo();
    assert.ok(daemon.host instanceof MultiplexerHost);
    assert.strictEqual(info.controlPort, 9333);
    assert.strictEqual(info.protocolVersion, 3);
    assert.strictEqual(info.minSupportedProtocolVersion, 2);
    assert.strictEqual(info.debugInfo.daemonVersion, "0.0.3");
    assert.strictEqual(info.debugInfo.protocolVersion, 3);
    assert.strictEqual(info.debugInfo.processId, process.pid);
    assert.strictEqual(typeof info.debugInfo.timestamp, "number");
    assertDefaultReportServiceInstalled();
    assert.deepStrictEqual(daemon.host.option, {
      controlPort: 9333,
      protocolVersion: 3,
      minSupportedProtocolVersion: 2,
      debugInfo: {
        daemonVersion: "0.0.3",
      },
    });
    assert.strictEqual(fs.existsSync(discoveryPath), false);
  });

  it("creates MultiplexerHost with optional metadata omitted when not provided", function () {
    const discoveryPath = path.join(tempDir, "daemon.json");
    const daemonLockPath = path.join(tempDir, "daemon.lock");
    const daemon = createMultiplexerDaemon({
      discoveryPath,
      daemonLockPath,
      protocolVersion: 1,
      minSupportedProtocolVersion: 1,
      controlPort: 9001,
      heartbeatInterval: 100000,
    });

    assert.ok(daemon.host instanceof MultiplexerHost);
    assertDefaultReportServiceInstalled();
    assert.deepStrictEqual(daemon.host.option, {
      controlPort: 9001,
      protocolVersion: 1,
      minSupportedProtocolVersion: 1,
    });
  });

  it("forwards parsed entry options into the constructed host", function () {
    resetFakeEntryHost();
    const restoreHost = replaceEntryHostCtor();
    const discoveryPath = path.join(tempDir, "daemon.json");
    const daemonLockPath = path.join(tempDir, "daemon.lock");

    try {
      createMultiplexerDaemon(
        createEntryOption({
          discoveryPath,
          daemonLockPath,
          protocolVersion: 4,
          minSupportedProtocolVersion: 2,
          controlPort: 9444,
          debugInfo: {
            daemonVersion: "0.0.4",
          },
          legacyDriverDir: "/tmp/legacy-driver",
          physicalConnectorOption: {
            manualConnect: true,
            enableAndroid: true,
            enableIOS: false,
            enableHarmony: false,
            enableNetworkDevice: false,
            usbConnectOpt: {
              retryTime: 5000,
            },
          },
        })
      );

      assert.strictEqual(FakeEntryHost.instances.length, 1);
      assertDefaultReportServiceInstalled();
      assert.deepStrictEqual(
        FakeEntryHost.instances[0].option,
        {
          controlPort: 9444,
          protocolVersion: 4,
          minSupportedProtocolVersion: 2,
          debugInfo: {
            daemonVersion: "0.0.4",
          },
          legacyDriverDir: "/tmp/legacy-driver",
          manualConnect: true,
          enableAndroid: true,
          enableIOS: false,
          enableHarmony: false,
          enableNetworkDevice: false,
          usbConnectOpt: {
            retryTime: 5000,
          },
        }
      );
    } finally {
      restoreHost();
    }
  });

  it("starts a daemon with the entry-created host and writes discovery from the host port", async function () {
    resetFakeEntryHost();
    const restoreHost = replaceEntryHostCtor();
    const discoveryPath = path.join(tempDir, "daemon.json");
    const daemonLockPath = path.join(tempDir, "daemon.lock");
    let daemon;

    try {
      daemon = createMultiplexerDaemon(
        createEntryOption({
          discoveryPath,
          daemonLockPath,
          controlPort: 0,
          debugInfo: {
            daemonVersion: "0.0.5",
          },
        })
      );

      await daemon.start();

      assert.strictEqual(FakeEntryHost.instances.length, 1);
      assert.deepStrictEqual(FakeEntryHost.instances[0].startCalls, [
        undefined,
      ]);
      assert.deepStrictEqual(readJson(discoveryPath), {
        pid: process.pid,
        protocolVersion: 1,
        minSupportedProtocolVersion: 1,
        controlPort: 9123,
        heartbeat: readJson(discoveryPath).heartbeat,
        startedAt: readJson(discoveryPath).startedAt,
        debugInfo: {
          protocolVersion: 1,
          daemonVersion: "0.0.5",
          processId: process.pid,
          timestamp: readJson(discoveryPath).heartbeat,
        },
      });

      await daemon.stop();
      assert.strictEqual(FakeEntryHost.instances[0].stopCalls, 1);
    } finally {
      if (daemon) {
        await daemon.stop().catch(() => {});
      }
      restoreHost();
    }
  });

  it("startMultiplexerDaemonEntry parses args, registers cleanup handlers, and starts the host", async function () {
    resetFakeEntryHost();
    const restoreHost = replaceEntryHostCtor();
    const processOnce = stubProcessOnce();
    const discoveryPath = path.join(tempDir, "daemon.json");
    const daemonLockPath = path.join(tempDir, "daemon.lock");
    let daemon;

    try {
      daemon = await startMultiplexerDaemonEntry([
        "--discovery-path",
        discoveryPath,
        "--daemon-lock-path",
        daemonLockPath,
        "--control-port",
        "9555",
        "--debug-info",
        '{"daemonVersion":"0.0.6"}',
      ]);

      assert.strictEqual(FakeEntryHost.instances.length, 1);
      assertDefaultReportServiceInstalled();
      assert.deepStrictEqual(
        FakeEntryHost.instances[0].option,
        {
          controlPort: 9555,
          protocolVersion: 1,
          minSupportedProtocolVersion: 1,
          debugInfo: {
            daemonVersion: "0.0.6",
          },
        }
      );
      assert.deepStrictEqual(
        processOnce.registrations.map((item) => item.event),
        [
          "beforeExit",
          "SIGINT",
          "SIGTERM",
          "uncaughtException",
          "unhandledRejection",
        ]
      );
      assert.deepStrictEqual(FakeEntryHost.instances[0].startCalls, [
        undefined,
      ]);
      assert.strictEqual(readJson(discoveryPath).controlPort, 9555);
    } finally {
      if (daemon) {
        await daemon.stop().catch(() => {});
      }
      processOnce.restore();
      restoreHost();
    }
  });

  it("startMultiplexerDaemonEntry still registers cleanup before propagating host start failures", async function () {
    resetFakeEntryHost();
    FakeEntryHost.startError = new Error("entry host failed");
    const restoreHost = replaceEntryHostCtor();
    const processOnce = stubProcessOnce();
    const discoveryPath = path.join(tempDir, "daemon.json");
    const daemonLockPath = path.join(tempDir, "daemon.lock");

    try {
      await assert.rejects(
        () =>
          startMultiplexerDaemonEntry([
            "--discovery-path",
            discoveryPath,
            "--daemon-lock-path",
            daemonLockPath,
          ]),
        /entry host failed/
      );

      assert.strictEqual(FakeEntryHost.instances.length, 1);
      assert.deepStrictEqual(FakeEntryHost.instances[0].startCalls, [
        undefined,
      ]);
      assert.strictEqual(FakeEntryHost.instances[0].stopCalls, 0);
      assert.deepStrictEqual(
        processOnce.registrations.map((item) => item.event),
        [
          "beforeExit",
          "SIGINT",
          "SIGTERM",
          "uncaughtException",
          "unhandledRejection",
        ]
      );
      assert.strictEqual(fs.existsSync(discoveryPath), false);
      assert.strictEqual(fs.existsSync(daemonLockPath), false);
    } finally {
      processOnce.restore();
      restoreHost();
      resetFakeEntryHost();
    }
  });

  it("runs process cleanup once when beforeExit is emitted repeatedly", async function () {
    resetFakeEntryHost();
    const restoreHost = replaceEntryHostCtor();
    const processOnce = stubProcessOnce();
    const discoveryPath = path.join(tempDir, "daemon.json");
    const daemonLockPath = path.join(tempDir, "daemon.lock");

    try {
      await startMultiplexerDaemonEntry([
        "--discovery-path",
        discoveryPath,
        "--daemon-lock-path",
        daemonLockPath,
      ]);

      const beforeExit = processOnce.registrations.find(
        (item) => item.event === "beforeExit"
      );
      beforeExit.handler();
      beforeExit.handler();
      await nextTick();

      assert.strictEqual(FakeEntryHost.instances[0].stopCalls, 1);
      assert.strictEqual(fs.existsSync(discoveryPath), false);
    } finally {
      processOnce.restore();
      restoreHost();
      resetFakeEntryHost();
    }
  });

  it("marks a clean exit as failed when cleanup throws", async function () {
    resetFakeEntryHost();
    const restoreHost = replaceEntryHostCtor(FakeStopFailHost);
    const processOnce = stubProcessOnce();
    const originalExitCode = process.exitCode;
    const discoveryPath = path.join(tempDir, "daemon.json");
    const daemonLockPath = path.join(tempDir, "daemon.lock");

    try {
      process.exitCode = 0;
      await startMultiplexerDaemonEntry([
        "--discovery-path",
        discoveryPath,
        "--daemon-lock-path",
        daemonLockPath,
      ]);

      const beforeExit = processOnce.registrations.find(
        (item) => item.event === "beforeExit"
      );
      beforeExit.handler();
      await nextTick();

      assert.strictEqual(FakeEntryHost.instances[0].stopCalls, 1);
      assert.strictEqual(process.exitCode, 1);
    } finally {
      process.exitCode = originalExitCode;
      processOnce.restore();
      restoreHost();
      resetFakeEntryHost();
    }
  });
});
