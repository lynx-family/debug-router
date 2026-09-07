// Copyright 2024 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

const assert = require("assert");

const {
  DEFAULT_MEMOIZED_QUERY_TTL_MS,
  MemoizedQueryTable,
} = require("../../../../debug_router_connector/dist/cjs/src/multiplexer/daemon/MemoizedQueryTable");

function createCustomizedMessage(type, data = []) {
  return {
    event: "Customized",
    data: {
      type,
      data,
      sender: 1,
    },
  };
}

function createNotification(type, data = []) {
  return JSON.stringify(createCustomizedMessage(type, data));
}

function recordNotification(table, clientId, message) {
  let parsedValue = null;
  try {
    parsedValue = JSON.parse(message);
  } catch (_error) {}
  table.recordNotification(clientId, message, parsedValue);
}

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

describe("MemoizedQueryTable", function () {
  const originalSetTimeout = global.setTimeout;
  const originalClearTimeout = global.clearTimeout;

  afterEach(function () {
    global.setTimeout = originalSetTimeout;
    global.clearTimeout = originalClearTimeout;
  });

  function useTimers(timers) {
    global.setTimeout = timers.setTimeout;
    global.clearTimeout = timers.clearTimeout;
  }

  it("coalesces ListSession and returns the recorded SessionList while fresh", function () {
    let now = 100;
    const table = new MemoizedQueryTable({
      validityPeriodMs: 50,
      now: () => now,
    });
    const query = createCustomizedMessage("ListSession");
    const notification = createNotification("SessionList", [
      { session_id: 1, url: "app://first" },
    ]);

    assert.deepStrictEqual(table.query(1, query), {
      action: "forward",
      requestType: "ListSession",
    });
    assert.deepStrictEqual(table.query(1, query), {
      action: "pending",
    });
    const parsedNotification = JSON.parse(notification);
    table.recordNotification(1, notification, parsedNotification);

    now = 150;
    const cached = table.query(1, query);
    assert.deepStrictEqual(cached, {
      action: "cached",
      message: notification,
      parsedValue: parsedNotification,
    });
    assert.strictEqual(cached.parsedValue, parsedNotification);
  });

  it("allows retry after pending and cached entries become stale", function () {
    let now = 200;
    const table = new MemoizedQueryTable({
      validityPeriodMs: 10,
      now: () => now,
    });
    const query = createCustomizedMessage("ListSession");

    assert.strictEqual(table.query(1, query).action, "forward");
    now = 210;
    assert.strictEqual(table.query(1, query).action, "pending");
    now = 211;
    assert.strictEqual(table.query(1, query).action, "forward");

    const notification = createNotification("SessionList");
    recordNotification(table, 1, notification);
    now = 221;
    assert.strictEqual(table.query(1, query).action, "cached");
    now = 222;
    assert.strictEqual(table.query(1, query).action, "forward");
  });

  it("retries a pending query until its notification is recorded", function () {
    let now = 300;
    const timers = createTimers();
    useTimers(timers);
    const table = new MemoizedQueryTable({
      validityPeriodMs: 10,
      now: () => now,
    });
    const query = createCustomizedMessage("ListSession");
    const retryCalls = [];

    const decision = table.query(1, query);
    assert.strictEqual(decision.action, "forward");
    table.setRetryTimer(1, decision.requestType, () => {
      retryCalls.push(now);
      return true;
    });
    assert.strictEqual(timers.timers.length, 1);
    assert.strictEqual(timers.timers[0].timeoutMs, 10);

    assert.strictEqual(table.query(1, query).action, "pending");
    assert.strictEqual(timers.timers.length, 1);

    now = 310;
    timers.run(timers.timers[0]);
    assert.deepStrictEqual(retryCalls, [310]);
    assert.strictEqual(timers.timers.length, 2);

    now = 320;
    timers.run(timers.timers[1]);
    assert.deepStrictEqual(retryCalls, [310, 320]);
    assert.strictEqual(timers.timers.length, 3);

    const notification = createNotification("SessionList");
    recordNotification(table, 1, notification);
    assert.strictEqual(timers.timers[2].cleared, true);
    timers.run(timers.timers[2]);
    assert.deepStrictEqual(retryCalls, [310, 320]);
    assert.strictEqual(table.query(1, query).action, "cached");
  });

  it("stops retrying when the retry callback cannot send", function () {
    const timers = createTimers();
    useTimers(timers);
    const table = new MemoizedQueryTable({
      validityPeriodMs: 10,
    });
    const query = createCustomizedMessage("ListSession");
    const decision = table.query(1, query);
    table.setRetryTimer(1, decision.requestType, () => false);

    timers.run(timers.timers[0]);

    assert.strictEqual(table.query(1, query).action, "forward");
    table.clear();
  });

  it("isolates state by runtime client and clears one client or all clients", function () {
    const table = new MemoizedQueryTable();
    const query = createCustomizedMessage("ListSession");
    const firstNotification = createNotification("SessionList", ["first"]);
    const secondNotification = createNotification("SessionList", ["second"]);

    recordNotification(table, 1, firstNotification);
    recordNotification(table, 2, secondNotification);
    assert.strictEqual(table.query(1, query).message, firstNotification);
    assert.strictEqual(table.query(2, query).message, secondNotification);

    table.clearClient(1);
    assert.strictEqual(table.query(1, query).action, "forward");
    assert.strictEqual(table.query(2, query).action, "cached");

    table.clear();
    assert.strictEqual(table.query(1, query).action, "forward");
    assert.strictEqual(table.query(2, query).action, "forward");
  });

  it("releases a pending query after the runtime send fails", function () {
    const timers = createTimers();
    useTimers(timers);
    const table = new MemoizedQueryTable();
    const query = createCustomizedMessage("ListSession");
    const decision = table.query(1, query);

    assert.strictEqual(decision.action, "forward");
    table.setRetryTimer(1, decision.requestType, () => true);
    table.handleSendFailure(1, decision.requestType);
    assert.strictEqual(timers.timers[0].cleared, true);
    assert.strictEqual(table.query(1, query).action, "forward");
  });

  it("cancels retry timers when one client or the whole table is cleared", function () {
    const timers = createTimers();
    useTimers(timers);
    const table = new MemoizedQueryTable();
    const query = createCustomizedMessage("ListSession");
    const first = table.query(1, query);
    const second = table.query(2, query);
    table.setRetryTimer(1, first.requestType, () => true);
    table.setRetryTimer(2, second.requestType, () => true);

    table.clearClient(1);
    assert.strictEqual(timers.timers[0].cleared, true);
    assert.strictEqual(timers.timers[1].cleared, false);

    table.clear();
    assert.strictEqual(timers.timers[1].cleared, true);
  });

  it("ignores unrelated, malformed, and unparseable messages", function () {
    const table = new MemoizedQueryTable();
    const query = createCustomizedMessage("ListSession");

    assert.deepStrictEqual(
      table.query(1, createCustomizedMessage("OpenCard")),
      { action: "not-memoized" }
    );
    assert.deepStrictEqual(table.query(1, { event: "Customized" }), {
      action: "not-memoized",
    });
    assert.deepStrictEqual(table.query(1, null), {
      action: "not-memoized",
    });
    assert.strictEqual(table.query(1, query).action, "forward");
    recordNotification(table, 1, "{bad-json");
    recordNotification(table, 1, createNotification("CDP"));
    assert.strictEqual(table.query(1, query).action, "pending");
  });

  it("supports additional declarative request and notification pairs", function () {
    const table = new MemoizedQueryTable({
      definitions: [
        {
          requestType: "GetState",
          notificationType: "StateChanged",
        },
      ],
    });
    const query = createCustomizedMessage("GetState");
    const notification = createNotification("StateChanged", { enabled: true });

    assert.strictEqual(table.query(3, query).action, "forward");
    recordNotification(table, 3, notification);
    assert.deepStrictEqual(table.query(3, query), {
      action: "cached",
      message: notification,
      parsedValue: JSON.parse(notification),
    });
    assert.strictEqual(
      table.query(3, createCustomizedMessage("ListSession")).action,
      "not-memoized"
    );
  });

  it("uses the default TTL when it is omitted", function () {
    let now = 1000;
    const table = new MemoizedQueryTable({
      now: () => now,
    });
    const query = createCustomizedMessage("ListSession");
    const notification = createNotification("SessionList");
    recordNotification(table, 1, notification);

    now += DEFAULT_MEMOIZED_QUERY_TTL_MS;
    assert.strictEqual(table.query(1, query).action, "cached");
    now++;
    assert.strictEqual(table.query(1, query).action, "forward");
  });
});
