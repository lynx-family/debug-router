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
const { parseEntryOption, startMultiplexerDaemonEntry } = entryModule;
const {
  DriverReportServiceImpl,
} = require("../../../../debug_router_connector/dist/cjs/src/report/interface/DriverReportServiceImpl");
const {
  getDriverReportService,
  setDriverReportService,
} = require("../../../../debug_router_connector/dist/cjs/src/report/interface/DriverReportService");

class FakeDaemonHost {
  static instances = [];
  static startError = null;
  static stopError = null;

  constructor(option) {
    this.option = option;
    this.startCalls = 0;
    this.stopCalls = 0;
    FakeDaemonHost.instances.push(this);
  }
  async start() {
    this.startCalls++;
    if (FakeDaemonHost.startError) throw FakeDaemonHost.startError;
  }
  async stop() {
    this.stopCalls++;
    if (FakeDaemonHost.stopError) throw FakeDaemonHost.stopError;
  }
  setIdleTimeoutHandler(handler) {
    this.idleHandler = handler;
  }
  setShutdownHandler(handler) {
    this.shutdownHandler = handler;
  }
}

function stubProcessExit() {
  const original = process.exit;
  const exitCodes = [];
  process.exit = (code) => {
    exitCodes.push(code);
  };
  return {
    exitCodes,
    restore() {
      process.exit = original;
    },
  };
}

function replaceDaemonHostCtor() {
  const hostImport = entryModule.__get__("MultiplexerDaemonHost_1");
  const original = hostImport.MultiplexerDaemonHost;
  hostImport.MultiplexerDaemonHost = FakeDaemonHost;
  return () => (hostImport.MultiplexerDaemonHost = original);
}

function createOption(tempDir, overrides = {}) {
  return {
    controlEndpoint:
      overrides.controlEndpoint ?? path.join(tempDir, "control.sock"),
    protocolVersion: overrides.protocolVersion ?? 1,
    multiplexerDaemonIdleTimeout: overrides.multiplexerDaemonIdleTimeout ?? -1,
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
    FakeDaemonHost.instances = [];
    FakeDaemonHost.startError = null;
    FakeDaemonHost.stopError = null;
  });

  afterEach(function () {
    setDriverReportService(null);
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("parses required daemon options", function () {
    assert.deepStrictEqual(
      parseEntryOption([
        "--control-endpoint",
        "/tmp/control.sock",
        "--protocol-version",
        "1",
        "--multiplexer-daemon-idle-timeout",
        "-1",
        "--debug-info",
        '{"daemonVersion":"1.2.3"}',
      ]),
      {
        controlEndpoint: "/tmp/control.sock",
        protocolVersion: 1,
        multiplexerDaemonIdleTimeout: -1,
        debugInfo: { daemonVersion: "1.2.3" },
      }
    );
  });

  it("parses optional daemon settings", function () {
    const option = parseEntryOption([
      "--control-endpoint",
      "/tmp/control.sock",
      "--protocol-version",
      "2",
      "--legacy-driver-dir",
      "/tmp/legacy",
      "--multiplexer-daemon-idle-timeout",
      "50",
      "--enable-websocket",
      "true",
      "--websocket-port",
      "9444",
      "--websocket-room-id",
      "room",
      "--connection-trace",
      '{"enabled":true,"output":"/tmp/trace"}',
      "--physical-connector-option",
      '{"enableAndroid":true}',
    ]);
    assert.deepStrictEqual(option, {
      controlEndpoint: "/tmp/control.sock",
      protocolVersion: 2,
      legacyDriverDir: "/tmp/legacy",
      multiplexerDaemonIdleTimeout: 50,
      enableWebSocket: true,
      websocketOption: { port: 9444, roomId: "room" },
      connectionTrace: { enabled: true, output: "/tmp/trace" },
      physicalConnectorOption: { enableAndroid: true },
    });
  });

  it("rejects removed daemon args and missing endpoint", function () {
    assert.throws(
      () => parseEntryOption(["--discovery-path", "/tmp/daemon.json"]),
      /Unknown multiplexer daemon option: discovery-path/
    );
    assert.throws(
      () =>
        parseEntryOption([
          "--control-endpoint",
          "/tmp/control.sock",
          "--daemon-lock-path",
          "/tmp/daemon.lock",
        ]),
      /Unknown multiplexer daemon option: daemon-lock-path/
    );
    assert.throws(
      () =>
        parseEntryOption([
          "--control-endpoint",
          "/tmp/control.sock",
          "--data-dir",
          "/tmp/multiplexer",
        ]),
      /Unknown multiplexer daemon option: data-dir/
    );
    assert.throws(
      () => parseEntryOption([]),
      /Missing required multiplexer daemon option: controlEndpoint/
    );
    assert.throws(
      () =>
        parseEntryOption([
          "--control-endpoint",
          "/tmp/control.sock",
          "--protocol-version",
          "1",
        ]),
      /Missing required multiplexer daemon option: multiplexerDaemonIdleTimeout/
    );
  });

  it("rejects unsupported argument forms and malformed JSON", function () {
    const base = [
      "--control-endpoint",
      "/tmp/control.sock",
      "--protocol-version",
      "1",
      "--multiplexer-daemon-idle-timeout",
      "-1",
    ];
    assert.throws(() => parseEntryOption([...base, "--debug-info", "{"]));
    assert.throws(
      () => parseEntryOption([...base, "--enable-websocket"]),
      /Missing value for multiplexer daemon option: enable-websocket/
    );
    assert.throws(
      () => parseEntryOption(["--control-endpoint=/tmp/control.sock"]),
      /Unknown multiplexer daemon option: control-endpoint=\/tmp\/control.sock/
    );
  });

  it("constructs Host with endpoint and omits daemon discovery state", async function () {
    const restore = replaceDaemonHostCtor();
    try {
      const option = createOption(tempDir, {
        protocolVersion: 3,
        debugInfo: { daemonVersion: "3" },
        enableWebSocket: true,
        physicalConnectorOption: { enableAndroid: true },
      });
      const createDaemonHost = entryModule.__get__("createDaemonHost");
      const host = createDaemonHost(option);
      assert.deepStrictEqual(FakeDaemonHost.instances[0].option, {
        controlEndpoint: option.controlEndpoint,
        protocolVersion: 3,
        multiplexerDaemonIdleTimeout: -1,
        debugInfo: { daemonVersion: "3" },
        enableWebSocket: true,
        physicalConnectorOption: { enableAndroid: true },
      });
      assert(getDriverReportService() instanceof DriverReportServiceImpl);
      await host.start();
      assert.strictEqual(
        fs.existsSync(path.join(tempDir, "daemon.lock")),
        false
      );
      assert.strictEqual(
        fs.existsSync(path.join(tempDir, "daemon.json")),
        false
      );
      await host.stop();
    } finally {
      restore();
    }
  });

  it("registers cleanup handlers before starting and cleans on beforeExit", async function () {
    const restoreHost = replaceDaemonHostCtor();
    const processOnce = stubProcessOnce();
    try {
      const option = createOption(tempDir);
      const host = await startMultiplexerDaemonEntry([
        "--control-endpoint",
        option.controlEndpoint,
        "--protocol-version",
        String(option.protocolVersion),
        "--multiplexer-daemon-idle-timeout",
        String(option.multiplexerDaemonIdleTimeout),
      ]);
      assert.strictEqual(host, FakeDaemonHost.instances[0]);
      assert.strictEqual(FakeDaemonHost.instances[0].startCalls, 1);
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
      assert.strictEqual(FakeDaemonHost.instances[0].stopCalls, 1);
    } finally {
      processOnce.restore();
      restoreHost();
    }
  });

  it("stops Host and exits for idle and shutdown requests", async function () {
    const restoreHost = replaceDaemonHostCtor();
    try {
      for (const kind of ["idle", "shutdown"]) {
        FakeDaemonHost.instances = [];
        const processOnce = stubProcessOnce();
        const processExit = stubProcessExit();
        try {
          const option = createOption(tempDir);
          const host = await startMultiplexerDaemonEntry([
            "--control-endpoint",
            option.controlEndpoint,
            "--protocol-version",
            String(option.protocolVersion),
            "--multiplexer-daemon-idle-timeout",
            String(option.multiplexerDaemonIdleTimeout),
          ]);

          await (kind === "idle" ? host.idleHandler() : host.shutdownHandler());

          assert.strictEqual(host.stopCalls, 1);
          assert.deepStrictEqual(processExit.exitCodes, [0]);
        } finally {
          processExit.restore();
          processOnce.restore();
        }
      }
    } finally {
      restoreHost();
    }
  });

  it("exits with failure when Host-requested cleanup fails", async function () {
    const restoreHost = replaceDaemonHostCtor();
    const processOnce = stubProcessOnce();
    const processExit = stubProcessExit();
    const originalExitCode = process.exitCode;
    FakeDaemonHost.stopError = new Error("entry host stop failed");
    try {
      const option = createOption(tempDir);
      const host = await startMultiplexerDaemonEntry([
        "--control-endpoint",
        option.controlEndpoint,
        "--protocol-version",
        String(option.protocolVersion),
        "--multiplexer-daemon-idle-timeout",
        String(option.multiplexerDaemonIdleTimeout),
      ]);

      await host.idleHandler();

      assert.strictEqual(host.stopCalls, 1);
      assert.deepStrictEqual(processExit.exitCodes, [1]);
    } finally {
      process.exitCode = originalExitCode;
      processExit.restore();
      processOnce.restore();
      restoreHost();
    }
  });

  it("propagates Host start failures without creating daemon.lock", async function () {
    const restoreHost = replaceDaemonHostCtor();
    const processOnce = stubProcessOnce();
    FakeDaemonHost.startError = new Error("entry host failed");
    try {
      const option = createOption(tempDir);
      await assert.rejects(
        () =>
          startMultiplexerDaemonEntry([
            "--control-endpoint",
            option.controlEndpoint,
            "--protocol-version",
            String(option.protocolVersion),
            "--multiplexer-daemon-idle-timeout",
            String(option.multiplexerDaemonIdleTimeout),
          ]),
        /entry host failed/
      );
      assert.strictEqual(
        fs.existsSync(path.join(tempDir, "daemon.lock")),
        false
      );
    } finally {
      processOnce.restore();
      restoreHost();
    }
  });
});
