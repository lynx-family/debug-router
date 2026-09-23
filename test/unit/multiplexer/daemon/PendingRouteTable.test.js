// Copyright 2024 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

const assert = require("assert");

const {
  DEFAULT_PENDING_ROUTE_TIMEOUT_MS,
  PendingRouteTable,
} = require("../../../../debug_router_connector/dist/cjs/src/multiplexer/daemon/PendingRouteTable");

function createTimers() {
  const timers = [];
  return {
    timers,
    setTimeout(callback, timeoutMs) {
      const timer = {
        callback,
        timeoutMs,
        cleared: false,
      };
      timers.push(timer);
      return timer;
    },
    clearTimeout(timer) {
      timer.cleared = true;
    },
    run(timer) {
      if (!timer.cleared) {
        timer.callback();
      }
    },
  };
}

describe("PendingRouteTable", function () {
  it("allocates sequential global message ids without reusing removed ids", function () {
    const timers = createTimers();
    const table = new PendingRouteTable({
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
    });
    const first = table.add({
      kind: "control",
      requesterId: 1,
      originalId: 10,
      clientId: 100,
    });
    const second = table.add({
      kind: "websocket",
      requesterId: 2,
      originalId: 20,
      clientId: 200,
    });

    assert.strictEqual(first.globalMessageId, 1);
    assert.strictEqual(second.globalMessageId, 2);
    table.take(first.globalMessageId);

    const third = table.add({
      kind: "control",
      requesterId: 3,
      originalId: 30,
      clientId: 300,
    });
    assert.strictEqual(third.globalMessageId, 3);
    table.clear();
  });

  it("adds, gets, takes, and clears a control route timer", function () {
    const timers = createTimers();
    let now = 100;
    const table = new PendingRouteTable({
      now: () => now,
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
    });
    const rejectCalls = [];

    const route = table.add({
      kind: "control",
      requesterId: 2,
      originalId: 3,
      clientId: 4,
      reject: (error) => rejectCalls.push(error),
    });

    assert.strictEqual(route.createdAt, 100);
    assert.strictEqual(route.globalMessageId, 1);
    assert.strictEqual(table.get(1), route);
    assert.strictEqual(timers.timers.length, 1);
    assert.strictEqual(
      timers.timers[0].timeoutMs,
      DEFAULT_PENDING_ROUTE_TIMEOUT_MS
    );

    now = 200;
    assert.strictEqual(table.take(1), route);
    assert.strictEqual(table.get(1), null);
    assert.strictEqual(timers.timers[0].cleared, true);
    timers.run(timers.timers[0]);
    assert.deepStrictEqual(rejectCalls, []);
  });

  it("supports websocket routes and clears their timers", function () {
    const timers = createTimers();
    const table = new PendingRouteTable({
      now: () => 500,
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
    });

    const route = table.add({
      kind: "websocket",
      requesterId: 6,
      originalId: 7,
      clientId: 8,
    });

    assert.deepStrictEqual(route, {
      kind: "websocket",
      requesterId: 6,
      originalId: 7,
      clientId: 8,
      globalMessageId: 1,
      createdAt: 500,
      timer: timers.timers[0],
    });
    assert.strictEqual(table.take(1), route);
    assert.strictEqual(timers.timers[0].cleared, true);
    assert.strictEqual(table.take(1), null);
  });

  it("clears only the matching control routes and clears their timers", function () {
    const timers = createTimers();
    const table = new PendingRouteTable({
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
    });
    const first = table.add({
      kind: "control",
      requesterId: 9,
      originalId: 101,
      clientId: 201,
    });
    const second = table.add({
      kind: "control",
      requesterId: 10,
      originalId: 102,
      clientId: 202,
    });
    const third = table.add({
      kind: "control",
      requesterId: 9,
      originalId: 103,
      clientId: 203,
    });
    table.add({
      kind: "websocket",
      requesterId: 9,
      originalId: 104,
      clientId: 204,
    });

    assert.deepStrictEqual(table.clearByControlId(9), [first, third]);
    assert.strictEqual(table.get(1), null);
    assert.strictEqual(table.get(2), second);
    assert.strictEqual(table.get(3), null);
    assert.strictEqual(table.get(4).kind, "websocket");
    assert.strictEqual(timers.timers[0].cleared, true);
    assert.strictEqual(timers.timers[1].cleared, false);
    assert.strictEqual(timers.timers[2].cleared, true);
    assert.strictEqual(timers.timers[3].cleared, false);
  });

  it("clears only the matching websocket routes and leaves control routes intact", function () {
    const timers = createTimers();
    const table = new PendingRouteTable({
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
    });
    const control = table.add({
      kind: "control",
      requesterId: 20,
      originalId: 10,
      clientId: 1,
    });
    const firstWeb = table.add({
      kind: "websocket",
      requesterId: 30,
      originalId: 11,
      clientId: 2,
    });
    table.add({
      kind: "websocket",
      requesterId: 31,
      originalId: 12,
      clientId: 3,
    });
    const secondWeb = table.add({
      kind: "websocket",
      requesterId: 30,
      originalId: 13,
      clientId: 4,
    });

    assert.deepStrictEqual(table.clearByWebClientId(30), [firstWeb, secondWeb]);
    assert.strictEqual(table.get(1), control);
    assert.strictEqual(table.get(2), null);
    assert.strictEqual(table.get(3).requesterId, 31);
    assert.strictEqual(table.get(4), null);
  });

  it("clears every route targeting a disconnected runtime client", function () {
    const timers = createTimers();
    const table = new PendingRouteTable({
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
    });
    const control = table.add({
      kind: "control",
      requesterId: 10,
      originalId: 1,
      clientId: 50,
    });
    const websocket = table.add({
      kind: "websocket",
      requesterId: 20,
      originalId: 2,
      clientId: 50,
    });
    const other = table.add({
      kind: "control",
      requesterId: 11,
      originalId: 3,
      clientId: 51,
    });

    assert.deepStrictEqual(table.clearByClientId(50), [control, websocket]);
    assert.strictEqual(table.get(3), other);
    assert.strictEqual(timers.timers[0].cleared, true);
    assert.strictEqual(timers.timers[1].cleared, true);
    assert.strictEqual(timers.timers[2].cleared, false);
  });

  it("clear removes every route and timer in insertion order", function () {
    const timers = createTimers();
    const table = new PendingRouteTable({
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
    });
    const first = table.add({
      kind: "control",
      requesterId: 1,
      originalId: 1,
      clientId: 1,
    });
    const second = table.add({
      kind: "websocket",
      requesterId: 2,
      originalId: 2,
      clientId: 2,
    });

    assert.deepStrictEqual(table.clear(), [first, second]);
    assert.strictEqual(table.get(first.globalMessageId), null);
    assert.strictEqual(table.get(second.globalMessageId), null);
    assert.strictEqual(
      timers.timers.every((timer) => timer.cleared),
      true
    );
    assert.deepStrictEqual(table.clear(), []);
  });

  it("times out control and websocket routes, rejects only control routes, and calls onTimeout", function () {
    const timers = createTimers();
    const timeoutRoutes = [];
    const rejected = [];
    const table = new PendingRouteTable({
      timeoutMs: 25,
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
      onTimeout: (route) => timeoutRoutes.push(route),
    });
    const control = table.add({
      kind: "control",
      requesterId: 1,
      originalId: 101,
      clientId: 11,
      reject: (error) => rejected.push(error),
    });
    const web = table.add({
      kind: "websocket",
      requesterId: 2,
      originalId: 102,
      clientId: 12,
    });

    timers.run(timers.timers[0]);
    timers.run(timers.timers[1]);
    timers.run(timers.timers[0]);

    assert.strictEqual(table.get(control.globalMessageId), null);
    assert.strictEqual(table.get(web.globalMessageId), null);
    assert.deepStrictEqual(timeoutRoutes, [control, web]);
    assert.strictEqual(rejected.length, 1);
    assert.match(
      rejected[0].message,
      /Timed out waiting for response to global message id 1/
    );
  });
});
