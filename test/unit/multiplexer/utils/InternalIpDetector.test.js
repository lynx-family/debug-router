// Copyright 2026 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

const assert = require("assert");
const { EventEmitter } = require("events");
const path = require("path");
const rewire = require(require.resolve("rewire", {
  paths: [path.join(__dirname, "../../../../debug_router_connector")],
}));
const detectorModule = rewire(
  "../../../../debug_router_connector/dist/cjs/src/utils/InternalIpDetector"
);
const { InternalIpDetector } = detectorModule;

describe("InternalIpDetector", function () {
  let socket, timeoutCallback, restores;
  beforeEach(function () {
    socket = new EventEmitter();
    socket.closeCalls = 0;
    socket.close = () => socket.closeCalls++;
    socket.unref = () => {};
    socket.address = () => ({ address: "10.0.0.2" });
    socket.connect = (port, target, callback) => {
      assert.strictEqual(port, 1);
      assert.strictEqual(target, "223.5.5.5");
      queueMicrotask(callback);
    };
    restores = [
      detectorModule.__set__("dgram_1", { createSocket: () => socket }),
      detectorModule.__set__("os_1", {
        networkInterfaces: () => ({
          lo0: [{ family: "IPv4", address: "127.0.0.1", internal: true }],
          en0: [{ family: "IPv4", address: "192.168.1.2", internal: false }],
          en1: [{ family: 4, address: "10.0.0.2", internal: false }],
        }),
      }),
      detectorModule.__set__("setTimeout", (callback) => {
        timeoutCallback = callback;
        return 1;
      }),
      detectorModule.__set__("clearTimeout", () => {}),
    ];
  });
  afterEach(function () {
    for (const restore of restores.reverse()) restore();
  });

  it("uses the OS-routed address instead of the first network interface", async function () {
    const result = await InternalIpDetector.detectInternalIPv4();
    assert.deepStrictEqual(result.selected, {
      address: "10.0.0.2",
      interface: "en1",
      source: "udp-route",
    });
    assert.strictEqual(socket.closeCalls, 1);
  });

  it("falls back to a non-loopback interface after a route error", async function () {
    socket.connect = () =>
      queueMicrotask(() => socket.emit("error", new Error("no route")));
    const result = await InternalIpDetector.detectInternalIPv4();
    assert.deepStrictEqual(result.selected, {
      address: "192.168.1.2",
      interface: "en0",
      source: "interface-fallback",
      probeError: "no route",
    });
    assert.strictEqual(socket.closeCalls, 1);
  });

  it("times out and closes the probe once even if its callback arrives late", async function () {
    let connected;
    socket.connect = (_port, _target, callback) => {
      connected = callback;
    };
    const pending = InternalIpDetector.detectInternalIPv4();
    timeoutCallback();
    connected();
    const result = await pending;
    assert.strictEqual(result.selected.source, "interface-fallback");
    assert.match(result.selected.probeError, /timed out/);
    assert.strictEqual(socket.closeCalls, 1);
  });

  it("does not advertise an unspecified address", async function () {
    socket.address = () => ({ address: "0.0.0.0" });
    const result = await InternalIpDetector.detectInternalIPv4();
    assert.strictEqual(result.selected.address, "192.168.1.2");
    assert.strictEqual(result.selected.source, "interface-fallback");
  });

  it("rejects fallback when only loopback, link-local and IPv6 addresses exist", async function () {
    restores.push(
      detectorModule.__set__("os_1", {
        networkInterfaces: () => ({
          lo0: [{ family: "IPv4", address: "127.0.0.1", internal: true }],
          en0: [
            { family: "IPv4", address: "169.254.1.2", internal: false },
            { family: "IPv6", address: "::1", internal: true },
          ],
        }),
      })
    );
    socket.connect = () => {
      throw new Error("no route");
    };
    await assert.rejects(
      InternalIpDetector.detectInternalIPv4(),
      /no fallback IPv4/
    );
    assert.strictEqual(socket.closeCalls, 1);
  });

  it("rejects a non-IPv4 probe target before opening a socket", async function () {
    await assert.rejects(
      InternalIpDetector.detectInternalIPv4("::1"),
      /valid IPv4/
    );
    assert.strictEqual(socket.closeCalls, 0);
  });
});
