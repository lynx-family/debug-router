// Copyright 2026 The Lynx Authors. All rights reserved.
// Licensed under the Apache License, Version 2.0.

const assert = require("assert");
const net = require("net");
const root = "../../../debug_router_connector/dist/cjs/src";
const { AdbHealthGuard } = require(`${root}/device/android/AdbHealthGuard`);
const AndroidDevice = require(`${root}/device/android/AndroidDevice`).default;
const { ClientController } = require(`${root}/usb/ClientController`);
const {
  setDriverReportService,
} = require(`${root}/report/interface/DriverReportService`);
const tick = () => new Promise((resolve) => setImmediate(resolve));
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
};

describe("Android ADB connection guard", function () {
  let guards, events, controllers, telemetry;
  beforeEach(() => {
    guards = [];
    events = [];
    controllers = [];
    telemetry = [];
    setDriverReportService({
      report: (...args) => telemetry.push(args),
    });
  });
  afterEach(() => {
    controllers.forEach((controller) => controller.close());
    guards.forEach((guard) => guard.close());
    setDriverReportService(null);
    assert.deepStrictEqual(telemetry, []);
  });

  function guard(shell) {
    const value = new AdbHealthGuard(
      { options: { host: "127.0.0.1", port: 5037 } },
      "redmi",
      (error) => events.push(error)
    );
    value.responseTimeoutMs = 15;
    value.retryDelayMs = 30;
    if (shell) value.shell = shell;
    guards.push(value);
    return value;
  }

  function controller(checkClientPort, os = "Android") {
    const value = new ClientController(
      { usbConnectRetryTime: 100000, unregiserUsbClient() {} },
      {
        ports: [10001, 10002],
        info: { serial: "redmi", os, title: "phone" },
        getHost: () => "127.0.0.1",
        checkClientPort,
      }
    );
    value.connectedPorts = [];
    value.destroyedPorts = [];
    value.createAdapter = (_, port) => ({
      connect() {
        value.connectedPorts.push(port);
        value.ports.set(port, true);
      },
      destroy() {
        value.destroyedPorts.push(port);
      },
    });
    controllers.push(value);
    return value;
  }

  it("backs off after timeout and retries without waiting for the old request", async () => {
    const pending = deferred();
    let calls = 0;
    const value = guard(() => {
      calls++;
      return calls === 1
        ? pending.promise
        : Promise.resolve("");
    });
    let result;
    const first = value.check(8901).then((reply) => (result = reply));
    await wait(25);
    assert.strictEqual(result, "pause");
    assert(value.retryAt > Date.now());
    for (let i = 0; i < 300; i++)
      assert.strictEqual(await value.check(8902), "pause");
    assert.strictEqual(calls, 1);
    assert.strictEqual(
      events.filter((e) => e.code === "ADB_UNRESPONSIVE").length,
      1
    );
    assert.strictEqual(await first, "pause");
    await wait(40);
    assert.strictEqual(await value.check(8902), "ready");
    assert.strictEqual(calls, 2);
    pending.resolve("nc: Timeout");
    await tick();
    assert(value.retryAt <= Date.now());
    assert.strictEqual(value.portRetryAt.size, 0);
  });

  for (const late of ["resolve", "reject"]) {
    it(`ignores a late ${late} without clearing the next attempt's timeout`, async () => {
      const old = deferred(),
        current = deferred();
      let calls = 0;
      const value = guard(() =>
        ++calls === 1 ? old.promise : current.promise
      );
      assert.strictEqual(await value.check(8901), "pause");
      await wait(40);
      const retryAt = value.retryAt;
      let result;
      const next = value.check(8902).then((reply) => (result = reply));
      if (late === "resolve") old.resolve("");
      else old.reject(new Error("late connection error"));
      await tick();
      assert.strictEqual(value.retryAt, retryAt);
      await wait(25);
      assert.strictEqual(result, "pause");
      assert.strictEqual(await next, "pause");
      assert(value.retryAt > Date.now());
      current.resolve("");
      await tick();
      assert(value.retryAt > Date.now());
    });
  }

  it("ignores a probe result received after its request times out", async () => {
    const pending = deferred();
    const commands = [];
    const value = guard((command) => {
      commands.push(command);
      return pending.promise;
    });
    assert.strictEqual(await value.check(8901), "pause");
    pending.resolve("");
    await tick();
    assert.deepStrictEqual(commands, [
      "toybox nc -z -w 2 127.0.0.1 8901 </dev/null",
    ]);
    assert(value.retryAt > Date.now());
  });

  it("returns pause immediately on close even if the request never settles", async () => {
    const pending = deferred();
    const value = guard(() => pending.promise);
    const result = value.check(8901);
    value.close();
    assert.strictEqual(await result, "pause");
    assert.strictEqual(value.abort, undefined);
    await wait(25);
    assert.deepStrictEqual(events, []);
  });

  it("ends a timed out scan without connecting on a stale success or adding probes", async () => {
    const pending = deferred();
    let calls = 0;
    const health = guard(() => {
      calls++;
      return calls === 1
        ? pending.promise
        : Promise.resolve("");
    });
    const value = controller((port) => health.check(port - 1100));
    value.startWatchClient();
    await wait(25);
    assert.strictEqual(value.scanning, false);
    for (let i = 0; i < 100; i++) {
      value.watchClient();
      await tick();
    }
    assert.strictEqual(calls, 1);
    assert.deepStrictEqual(value.connectedPorts, []);
    pending.resolve("");
    await tick();
    assert.deepStrictEqual(value.connectedPorts, []);
    await wait(40);
    value.watchClient();
    await tick();
    assert.strictEqual(calls, 3); // Both ports require a fresh preflight.
    assert.deepStrictEqual(value.connectedPorts, [10001, 10002]);
  });

  it("backs off only the timed out port and allows other ports and later recovery", async () => {
    const commands = [];
    let frozen = true;
    const value = guard(async (cmd) => {
      commands.push(cmd);
      return cmd.includes("8901") && frozen
        ? "nc: Timeout"
        : "";
    });
    assert.strictEqual(await value.check(8901), "skip");
    assert.strictEqual(await value.check(8901), "skip");
    assert.strictEqual(await value.check(8902), "ready");
    assert.strictEqual(commands.length, 2);
    assert.deepStrictEqual(events, []);
    frozen = false;
    await wait(40);
    assert.strictEqual(await value.check(8901), "ready");
    assert.strictEqual(value.portRetryAt.size, 0);
  });

  it("allows command failures without classifying them as adbd blocking", async () => {
    const commands = [];
    for (const result of [
      "nc: connect: Connection refused",
      "permission denied",
      "nc: Unknown option 'z'",
      "toybox: not found",
    ]) {
      const value = guard(async (command) => {
        commands.push(command);
        return result;
      });
      assert.strictEqual(await value.check(8901), "ready");
      assert.strictEqual(value.portRetryAt.size, 0);
      assert.strictEqual(value.retryAt, 0);
    }
    assert.deepStrictEqual(
      commands,
      Array(4).fill("toybox nc -z -w 2 127.0.0.1 8901 </dev/null")
    );
    assert.strictEqual(events.length, 0);
  });

  it("skips invalid ports without issuing a probe", async () => {
    const value = guard(async () => {
      throw new Error("unexpected probe");
    });
    for (const port of [
      undefined,
      null,
      0,
      -1,
      65536,
      1.5,
      NaN,
      "8901; reboot",
    ]) {
      assert.strictEqual(await value.check(port), "skip");
    }
    assert.strictEqual(events.length, 0);
  });

  it("backs off ended ADB failures without retrying immediately", async () => {
    let calls = 0;
    const value = guard(async () => {
      calls++;
      throw new Error("device offline");
    });
    assert.strictEqual(await value.check(8901), "pause");
    assert.strictEqual(await value.check(8902), "pause");
    assert.strictEqual(calls, 1);
    await wait(40);
    value.shell = async () => "";
    assert.strictEqual(await value.check(8902), "ready");
  });

  it("skips frozen ports without probing or replacing an already registered SDK connection", async () => {
    const ports = [];
    const value = controller(async (port) => {
      ports.push(port);
      return port === 10001 ? "skip" : "ready";
    });
    value.startWatchClient();
    await tick();
    assert.deepStrictEqual(value.connectedPorts, [10002]);
    for (let i = 0; i < 4; i++) {
      value.watchClient();
      await tick();
    }
    assert.deepStrictEqual(ports, [10001, 10002, 10001, 10001, 10001, 10001]);
    assert.deepStrictEqual(value.destroyedPorts, []);
    assert.deepStrictEqual(value.connectedPorts, [10002]);
  });

  it("does not resurrect a stopped watcher when its probe finishes after replacement", async () => {
    const pending = deferred();
    let calls = 0;
    const health = guard(() => {
      calls++;
      return pending.promise;
    });
    const first = controller((port) => health.check(port - 1100));
    first.startWatchClient();
    first.close();
    const second = controller((port) => health.check(port - 1100));
    second.startWatchClient();
    await tick();
    assert.strictEqual(calls, 2);
    pending.resolve("");
    await tick();
    assert.deepStrictEqual(first.connectedPorts, []);
    assert.strictEqual(calls, 3);
    assert.deepStrictEqual(second.connectedPorts, [10001, 10002]);
  });

  it("keeps non-Android scans synchronous and skips checks with no candidates", async () => {
    const ios = controller(() => {
      throw new Error("must not probe iOS");
    }, "iOS");
    ios.startWatchClient();
    assert.deepStrictEqual(ios.connectedPorts, [10001, 10002]);
    const ports = [];
    const android = controller(async (port) => {
      ports.push(port);
      return "ready";
    });
    android.ports.set(10001, true);
    android.ports.set(10002, true);
    android.startWatchClient();
    await tick();
    assert.deepStrictEqual(ports, []);
  });

  it("uses the explicit forward map and rejects results for obsolete mappings", async () => {
    const device = new AndroidDevice({}, "redmi", "phone", { options: {} });
    guards.push(device.healthGuard);
    device.forwardedPorts.set(12001, 8902); // 8901 failed to forward.
    const pending = deferred();
    const ports = [];
    device.healthGuard.check = (port) => {
      ports.push(port);
      return pending.promise;
    };
    assert.strictEqual(await device.checkClientPort(12002), "skip");
    const result = device.checkClientPort(12001);
    device.forwardedPorts.set(12001, 8903);
    pending.resolve("ready");
    assert.strictEqual(await result, "pause");
    assert.deepStrictEqual(ports, [8902]);
    device.disconnect();
    assert.strictEqual(await device.checkClientPort(12001), "pause");
  });

  // Exercise real adbkit framing and socket cleanup, including the stage before
  // a shell stream is available. This is a local fake smart-socket server.
  async function fakeAdb(handle) {
    const sockets = new Set();
    const server = net.createServer((socket) => {
      sockets.add(socket);
      socket.on("error", () => {});
      socket.on("close", () => sockets.delete(socket));
      let data = Buffer.alloc(0);
      socket.on("data", (chunk) => {
        data = Buffer.concat([data, chunk]);
        while (data.length >= 4) {
          const length = parseInt(data.subarray(0, 4).toString(), 16);
          if (data.length < length + 4) return;
          const command = data.subarray(4, length + 4).toString();
          data = data.subarray(length + 4);
          handle(socket, command);
        }
      });
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    return {
      options: { host: "127.0.0.1", port: server.address().port },
      sockets,
      async close() {
        sockets.forEach((socket) => socket.destroy());
        await new Promise((resolve) => server.close(resolve));
      },
    };
  }

  for (const stage of ["transport", "shell"]) {
    it(`closes a timed out ${stage} socket and reconnects after backoff`, async () => {
      let responsive = false;
      const server = await fakeAdb((socket, command) => {
        if (!responsive && stage === "transport") return;
        if (command.startsWith("host:transport:")) socket.write("OKAY");
        else if (responsive) {
          socket.end("OKAY");
        }
      });
      try {
        const value = new AdbHealthGuard(server, "redmi");
        value.responseTimeoutMs = 100;
        value.retryDelayMs = 30;
        guards.push(value);
        assert.strictEqual(await value.check(8901), "pause");
        assert.strictEqual(await value.check(8902), "pause");
        for (let i = 0; i < 100 && server.sockets.size; i++) await wait(5);
        assert.strictEqual(server.sockets.size, 0);
        responsive = true;
        await wait(40);
        assert.strictEqual(await value.check(8901), "ready");
      } finally {
        await server.close();
      }
    });
  }

  it("accepts empty or unknown shell output and releases the sockets", async () => {
    let output = "";
    const server = await fakeAdb((socket, command) => {
      if (command.startsWith("host:transport:")) socket.write("OKAY");
      else {
        assert.strictEqual(command, "shell:toybox nc -z -w 2 127.0.0.1 8901 </dev/null");
        socket.end(`OKAY${output}`);
      }
    });
    try {
      const value = new AdbHealthGuard(server, "redmi");
      guards.push(value);
      assert.strictEqual(await value.check(8901), "ready");
      output = "unexpected output";
      assert.strictEqual(await value.check(8901), "ready");
      await tick();
      assert.strictEqual(value.abort, undefined);
      for (let i = 0; i < 100 && server.sockets.size; i++) await wait(5);
      assert.strictEqual(server.sockets.size, 0);
    } finally {
      await server.close();
    }
  });

  it("closes an outstanding transport request when the device is removed", async () => {
    const received = deferred();
    const server = await fakeAdb(() => received.resolve());
    try {
      const value = new AdbHealthGuard(server, "redmi");
      guards.push(value);
      const result = value.check(8901);
      await received.promise;
      value.close();
      assert.strictEqual(await result, "pause");
      assert.strictEqual(value.abort, undefined);
      assert.strictEqual(events.length, 0);
    } finally {
      await server.close();
    }
  });
});
