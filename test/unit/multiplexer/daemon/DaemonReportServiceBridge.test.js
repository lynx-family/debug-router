// Copyright 2026 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

const assert = require("assert");
const {
  DaemonReportServiceBridge,
  MAX_REPORT_QUEUE_LENGTH,
} = require("../../../../debug_router_connector/dist/cjs/src/multiplexer/daemon/DaemonReportServiceBridge");

describe("DaemonReportServiceBridge", function () {
  function setup(send) {
    const received = [];
    const bridge = new DaemonReportServiceBridge((controlId, data) => {
      received.push({ controlId, ...data });
      send?.(bridge, data);
    });
    return { bridge, received };
  }

  it("queues report parameters directly and drains them in order", function () {
    const { bridge, received } = setup();
    const categories = { serial: "original" };
    bridge.init(true);
    bridge.report("first", undefined, categories);
    categories.serial = "changed";
    bridge.report("second", { duration: 1 }, null);
    assert.deepStrictEqual(received, []);
    bridge.updateStatus({ type: "forward", controlId: 2 });
    bridge.updateStatus({ type: "forward", controlId: 2 });
    bridge.report("third", null, {});
    assert.deepStrictEqual(received, [
      {
        controlId: 2,
        eventName: "first",
        metrics: null,
        categories: { serial: "changed" },
      },
      {
        controlId: 2,
        eventName: "second",
        metrics: { duration: 1 },
        categories: null,
      },
      { controlId: 2, eventName: "third", metrics: null, categories: {} },
    ]);
    assert.strictEqual(received[0].categories, categories);
  });

  it("sends connected reports immediately while draining the backlog", function () {
    const { bridge, received } = setup((bridge, data) => {
      if (data.eventName === "first") {
        bridge.report("live", null, {});
        assert.deepStrictEqual(
          received.map((r) => r.eventName),
          ["first", "live"]
        );
      }
    });
    bridge.report("first", null, {});
    bridge.report("second", null, {});
    bridge.updateStatus({ type: "forward", controlId: 1 });
    assert.deepStrictEqual(
      received.map((r) => r.eventName),
      ["first", "live", "second"]
    );
  });

  it("keeps queued reports until a reporting recipient is available", function () {
    const { bridge, received } = setup();
    bridge.report("startup", null, {});
    bridge.updateStatus({ type: "disconnected" });
    bridge.report("disabled", null, {});
    assert.deepStrictEqual(received, []);
    bridge.updateStatus({ type: "forward", controlId: 1 });
    bridge.report("enabled", null, {});
    assert.deepStrictEqual(
      received.map((r) => r.eventName),
      ["startup", "disabled", "enabled"]
    );
  });

  it("pauses a drain when disconnected and retains only unsent events", function () {
    const { bridge, received } = setup((bridge, data) => {
      if (data.eventName === "first")
        bridge.updateStatus({ type: "disconnected" });
    });
    bridge.report("first", null, {});
    bridge.report("second", null, {});
    bridge.updateStatus({ type: "forward", controlId: 1 });
    bridge.report("third", null, {});
    assert.strictEqual(received.length, 1);
    bridge.updateStatus({ type: "forward", controlId: 2 });
    assert.deepStrictEqual(
      received.map((r) => [r.controlId, r.eventName]),
      [
        [1, "first"],
        [2, "second"],
        [2, "third"],
      ]
    );
  });

  it("switches recipients during drain without duplicating the current report", function () {
    const { bridge, received } = setup((bridge, data) => {
      if (data.eventName === "first")
        bridge.updateStatus({ type: "forward", controlId: 2 });
    });
    bridge.report("first", null, {});
    bridge.report("second", null, {});
    bridge.updateStatus({ type: "forward", controlId: 1 });
    assert.deepStrictEqual(
      received.map((r) => [r.controlId, r.eventName]),
      [
        [1, "first"],
        [2, "second"],
      ]
    );
  });

  it("evicts the oldest reports at the count limit without a byte size limit", function () {
    const { bridge, received } = setup();
    const eventNames = Array.from(
      { length: MAX_REPORT_QUEUE_LENGTH + 2 },
      (_, i) => String(i)
    );
    for (const eventName of eventNames) bridge.report(eventName, null, {});
    const categories = { data: "x".repeat(1024 * 1024 + 1) };
    bridge.report("large", null, categories);
    bridge.updateStatus({ type: "forward", controlId: 1 });
    assert.strictEqual(received.length, MAX_REPORT_QUEUE_LENGTH);
    assert.deepStrictEqual(
      received.map((r) => r.eventName),
      [...eventNames.slice(3), "large"]
    );
    assert.strictEqual(
      received[MAX_REPORT_QUEUE_LENGTH - 1].categories,
      categories
    );
  });

  it("isolates failed sends without retry", function () {
    const { bridge, received } = setup((_bridge, data) => {
      if (data.eventName === "failure") throw new Error("send failed");
    });
    bridge.report("failure", null, {});
    bridge.report("success", null, {});
    assert.doesNotThrow(() =>
      bridge.updateStatus({ type: "forward", controlId: 1 })
    );
    assert.doesNotThrow(() => bridge.report("failure", null, {}));
    bridge.report("success", null, {});
    bridge.updateStatus({ type: "forward", controlId: 2 });
    assert.deepStrictEqual(
      received.map((r) => r.eventName),
      ["failure", "success", "failure", "success"]
    );
  });

  it("discards queued and late events when closed", function () {
    const { bridge, received } = setup();
    bridge.report("queued", null, {});
    bridge.close();
    bridge.report("late", null, {});
    bridge.updateStatus({ type: "disconnected" });
    bridge.report("after-disconnect", null, {});
    bridge.updateStatus({ type: "forward", controlId: 1 });
    bridge.report("after-reconnect", null, {});
    bridge.close();
    assert.deepStrictEqual(received, []);
  });

  it("stops draining when closed during a send", function () {
    const { bridge, received } = setup((bridge) => bridge.close());
    bridge.report("first", null, {});
    bridge.report("second", null, {});
    bridge.updateStatus({ type: "forward", controlId: 1 });
    bridge.updateStatus({ type: "forward", controlId: 2 });
    bridge.report("late", null, {});
    assert.deepStrictEqual(
      received.map((r) => r.eventName),
      ["first"]
    );
  });
});
