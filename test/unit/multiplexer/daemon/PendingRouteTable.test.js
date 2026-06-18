// Copyright 2024 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

const assert = require("assert");

require("../register_ts");

const {
  DEFAULT_PENDING_ROUTE_TIMEOUT_MS,
  PendingRouteTable,
} = require("../../../../debug_router_connector/src/multiplexer/daemon/PendingRouteTable");

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
  it("adds, gets, takes, and clears a control route timer", function () {
    const timers = createTimers();
    let now = 100;
    const table = new PendingRouteTable({
      now: () => now,
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
    });
    const rejectCalls = [];

    const route = table.add(10, {
      kind: "control",
      controlId: 2,
      originalId: 3,
      clientId: 4,
      reject: (error) => rejectCalls.push(error),
    });

    assert.strictEqual(route.createdAt, 100);
    assert.strictEqual(route.globalMessageId, 10);
    assert.strictEqual(table.size, 1);
    assert.strictEqual(table.has(10), true);
    assert.strictEqual(table.get(10), route);
    assert.strictEqual(timers.timers.length, 1);
    assert.strictEqual(
      timers.timers[0].timeoutMs,
      DEFAULT_PENDING_ROUTE_TIMEOUT_MS
    );

    now = 200;
    assert.strictEqual(table.take(10), route);
    assert.strictEqual(table.size, 0);
    assert.strictEqual(table.get(10), null);
    assert.strictEqual(timers.timers[0].cleared, true);
    timers.run(timers.timers[0]);
    assert.deepStrictEqual(rejectCalls, []);
  });

  it("supports websocket routes and disabled timers", function () {
    const timers = createTimers();
    const table = new PendingRouteTable({
      timeoutMs: 0,
      now: () => 500,
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
    });

    const route = table.add(11, {
      kind: "websocket",
      webClientId: 6,
      originalId: 7,
      clientId: 8,
    });

    assert.deepStrictEqual(route, {
      kind: "websocket",
      webClientId: 6,
      originalId: 7,
      clientId: 8,
      globalMessageId: 11,
      createdAt: 500,
    });
    assert.deepStrictEqual(timers.timers, []);
    assert.strictEqual(table.delete(11), route);
    assert.strictEqual(table.delete(11), null);
  });

  it("rejects duplicate global message ids without replacing the existing route", function () {
    const table = new PendingRouteTable({
      timeoutMs: 0,
    });
    const first = table.add(1, {
      kind: "control",
      controlId: 1,
      originalId: 1,
      clientId: 1,
    });

    assert.throws(
      () =>
        table.add(1, {
          kind: "websocket",
          webClientId: 2,
          originalId: 2,
          clientId: 2,
        }),
      /Pending route already exists/
    );
    assert.strictEqual(table.size, 1);
    assert.strictEqual(table.get(1), first);
  });

  it("clears only the matching control routes and clears their timers", function () {
    const timers = createTimers();
    const table = new PendingRouteTable({
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
    });
    const first = table.add(1, {
      kind: "control",
      controlId: 9,
      originalId: 101,
      clientId: 201,
    });
    const second = table.add(2, {
      kind: "control",
      controlId: 10,
      originalId: 102,
      clientId: 202,
    });
    const third = table.add(3, {
      kind: "control",
      controlId: 9,
      originalId: 103,
      clientId: 203,
    });
    table.add(4, {
      kind: "websocket",
      webClientId: 9,
      originalId: 104,
      clientId: 204,
    });

    assert.deepStrictEqual(table.clearByControlId(9), [first, third]);
    assert.strictEqual(table.size, 2);
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
    const control = table.add(1, {
      kind: "control",
      controlId: 20,
      originalId: 10,
      clientId: 1,
    });
    const firstWeb = table.add(2, {
      kind: "websocket",
      webClientId: 30,
      originalId: 11,
      clientId: 2,
    });
    table.add(3, {
      kind: "websocket",
      webClientId: 31,
      originalId: 12,
      clientId: 3,
    });
    const secondWeb = table.add(4, {
      kind: "websocket",
      webClientId: 30,
      originalId: 13,
      clientId: 4,
    });

    assert.deepStrictEqual(table.clearByWebClientId(30), [firstWeb, secondWeb]);
    assert.strictEqual(table.size, 2);
    assert.strictEqual(table.get(1), control);
    assert.strictEqual(table.get(2), null);
    assert.strictEqual(table.get(3).webClientId, 31);
    assert.strictEqual(table.get(4), null);
  });

  it("clear removes every route and timer in insertion order", function () {
    const timers = createTimers();
    const table = new PendingRouteTable({
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
    });
    const first = table.add(1, {
      kind: "control",
      controlId: 1,
      originalId: 1,
      clientId: 1,
    });
    const second = table.add(2, {
      kind: "websocket",
      webClientId: 2,
      originalId: 2,
      clientId: 2,
    });

    assert.deepStrictEqual(table.clear(), [first, second]);
    assert.strictEqual(table.size, 0);
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
    const control = table.add(1, {
      kind: "control",
      controlId: 1,
      originalId: 101,
      clientId: 11,
      reject: (error) => rejected.push(error),
    });
    const web = table.add(2, {
      kind: "websocket",
      webClientId: 2,
      originalId: 102,
      clientId: 12,
    });

    timers.run(timers.timers[0]);
    timers.run(timers.timers[1]);
    timers.run(timers.timers[0]);

    assert.strictEqual(table.size, 0);
    assert.deepStrictEqual(timeoutRoutes, [control, web]);
    assert.strictEqual(rejected.length, 1);
    assert.match(
      rejected[0].message,
      /Timed out waiting for response to global message id 1/
    );
  });

  it("validates every id field before inserting a route", function () {
    const cases = [
      {
        name: "globalMessageId",
        run: () =>
          new PendingRouteTable().add(1.1, {
            kind: "control",
            controlId: 1,
            originalId: 1,
            clientId: 1,
          }),
      },
      {
        name: "originalId",
        run: () =>
          new PendingRouteTable().add(1, {
            kind: "control",
            controlId: 1,
            originalId: Number.NaN,
            clientId: 1,
          }),
      },
      {
        name: "clientId",
        run: () =>
          new PendingRouteTable().add(1, {
            kind: "websocket",
            webClientId: 1,
            originalId: 1,
            clientId: Number.POSITIVE_INFINITY,
          }),
      },
      {
        name: "controlId",
        run: () =>
          new PendingRouteTable().add(1, {
            kind: "control",
            controlId: 1.2,
            originalId: 1,
            clientId: 1,
          }),
      },
      {
        name: "webClientId",
        run: () =>
          new PendingRouteTable().add(1, {
            kind: "websocket",
            webClientId: Number.MAX_SAFE_INTEGER + 1,
            originalId: 1,
            clientId: 1,
          }),
      },
    ];

    for (const item of cases) {
      assert.throws(
        item.run,
        new RegExp(`${item.name} must be a safe integer`)
      );
    }
  });
});
