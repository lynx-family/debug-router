// Copyright 2024 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

const assert = require("assert");

const {
  DEFAULT_MEMOIZED_NOTIFICATION_TTL_MS,
  MemoizedNotificationQueryTable,
} = require("../../../../debug_router_connector/dist/cjs/src/multiplexer/daemon/MemoizedNotificationQueryTable");

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

describe("MemoizedNotificationQueryTable", function () {
  it("coalesces ListSession and returns the recorded SessionList while fresh", function () {
    let now = 100;
    const table = new MemoizedNotificationQueryTable({
      ttlMs: 50,
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
    assert.strictEqual(table.recordNotification(1, notification), true);

    now = 150;
    assert.deepStrictEqual(table.query(1, query), {
      action: "cached",
      message: notification,
    });
  });

  it("allows retry after pending and cached entries become stale", function () {
    let now = 200;
    const table = new MemoizedNotificationQueryTable({
      ttlMs: 10,
      now: () => now,
    });
    const query = createCustomizedMessage("ListSession");

    assert.strictEqual(table.query(1, query).action, "forward");
    now = 210;
    assert.strictEqual(table.query(1, query).action, "pending");
    now = 211;
    assert.strictEqual(table.query(1, query).action, "forward");

    const notification = createNotification("SessionList");
    assert.strictEqual(table.recordNotification(1, notification), true);
    now = 221;
    assert.strictEqual(table.query(1, query).action, "cached");
    now = 222;
    assert.strictEqual(table.query(1, query).action, "forward");
  });

  it("isolates state by runtime client and clears one client or all clients", function () {
    const table = new MemoizedNotificationQueryTable();
    const query = createCustomizedMessage("ListSession");
    const firstNotification = createNotification("SessionList", ["first"]);
    const secondNotification = createNotification("SessionList", ["second"]);

    table.recordNotification(1, firstNotification);
    table.recordNotification(2, secondNotification);
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
    const table = new MemoizedNotificationQueryTable();
    const query = createCustomizedMessage("ListSession");
    const decision = table.query(1, query);

    assert.strictEqual(decision.action, "forward");
    table.handleSendFailure(1, decision.requestType);
    assert.strictEqual(table.query(1, query).action, "forward");
  });

  it("ignores unrelated, malformed, and unparseable messages", function () {
    const table = new MemoizedNotificationQueryTable();

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
    assert.strictEqual(table.recordNotification(1, "{bad-json"), false);
    assert.strictEqual(
      table.recordNotification(1, createNotification("CDP")),
      false
    );
  });

  it("supports additional declarative request and notification pairs", function () {
    const table = new MemoizedNotificationQueryTable({
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
    assert.strictEqual(table.recordNotification(3, notification), true);
    assert.deepStrictEqual(table.query(3, query), {
      action: "cached",
      message: notification,
    });
    assert.strictEqual(
      table.query(3, createCustomizedMessage("ListSession")).action,
      "not-memoized"
    );
  });

  it("uses the default TTL for missing or invalid values", function () {
    for (const ttlMs of [undefined, -1, Number.NaN]) {
      let now = 1000;
      const table = new MemoizedNotificationQueryTable({
        ttlMs,
        now: () => now,
      });
      const query = createCustomizedMessage("ListSession");
      const notification = createNotification("SessionList");
      table.recordNotification(1, notification);

      now += DEFAULT_MEMOIZED_NOTIFICATION_TTL_MS;
      assert.strictEqual(table.query(1, query).action, "cached");
      now++;
      assert.strictEqual(table.query(1, query).action, "forward");
    }
  });
});
