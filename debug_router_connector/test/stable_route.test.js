// Copyright 2024 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

const assert = require("node:assert/strict");
const { test } = require("node:test");

const {
  DebugRouterConnector,
} = require("../dist/cjs/src/connector/DebugRouterConnector.js");
const {
  WebSocketClient,
} = require("../dist/cjs/src/websocket/WebSocketConnection.js");
const {
  WebSocketController,
} = require("../dist/cjs/src/websocket/WebSocketServer.js");

test("late-binds a stable route once after its numeric target changes", () => {
  const oldRoute = createUsbClient(2, "stable-app");
  const currentRoute = createUsbClient(10, "stable-app");
  const harness = createConnectorHarness([currentRoute]);

  dispatch(harness.connector, 2, "stable-app");

  assert.equal(oldRoute.messages.length, 0);
  assert.equal(currentRoute.messages.length, 1);
  assert.equal(currentRoute.messages[0].debugRouterId, undefined);
  assert.equal(currentRoute.messages[0].data.data.client_id, -1);
  assert.deepEqual(harness.rejections, []);
});

test("rejects missing and ambiguous stable routes only to the originating Driver", () => {
  for (const { clients, reason } of [
    { clients: [], reason: "not_found" },
    {
      clients: [
        createUsbClient(10, "stable-app"),
        createUsbClient(11, "stable-app"),
      ],
      reason: "ambiguous",
    },
  ]) {
    const harness = createConnectorHarness(clients);

    dispatch(harness.connector, 2, "stable-app", 91);

    assert.equal(clients.flatMap((client) => client.messages).length, 0);
    assert.deepEqual(harness.rejections, [
      {
        id: 91,
        message: {
          event: "RouteRejected",
          data: {
            debugRouterId: "stable-app",
            target: 2,
            reason,
          },
        },
      },
    ]);
  }
});

test("keeps numeric routing for legacy messages without a stable route", () => {
  const numericRoute = createUsbClient(2, "stable-app");
  const harness = createConnectorHarness([numericRoute]);

  dispatch(harness.connector, 2);

  assert.equal(numericRoute.messages.length, 1);
  assert.equal(numericRoute.messages[0].data.data.client_id, -1);
  assert.deepEqual(harness.rejections, []);
});

test("rejects an unwritable stable route without sending to the App", () => {
  const route = createUsbClient(10, "stable-app", false);
  const harness = createConnectorHarness([route]);

  dispatch(harness.connector, 2, "stable-app", 91);

  assert.equal(route.messages.length, 0);
  assert.deepEqual(harness.rejections, [
    {
      id: 91,
      message: {
        event: "RouteRejected",
        data: {
          debugRouterId: "stable-app",
          target: 2,
          reason: "write_failed",
        },
      },
    },
  ]);
});

test("passes the originating Driver id into route dispatch", () => {
  const calls = [];
  const client = {
    clientId: () => 91,
    server: {
      sendMessageToApp(...args) {
        calls.push(args);
      },
    },
    type: () => "Driver",
  };
  const message = createMessage("stable-app");

  WebSocketClient.prototype.handleCustomizedMessage.call(
    client,
    message,
    JSON.stringify(message),
  );

  assert.deepEqual(calls, [[2, JSON.stringify(message), 91]]);
});

test("a stable route bypasses a reused numeric WebSocket App id", () => {
  const staleMessages = [];
  const routeCalls = [];
  const message = createMessage("stable-app");
  const controller = {
    driver: {
      handleWsMessage(...args) {
        routeCalls.push(args);
      },
    },
    websocketAppClients: new Map([
      [
        2,
        {
          sendMessage: (message) => staleMessages.push(message),
        },
      ],
    ]),
  };

  WebSocketController.prototype.sendMessageToApp.call(
    controller,
    2,
    JSON.stringify(message),
    91,
  );

  assert.deepEqual(staleMessages, []);
  assert.deepEqual(routeCalls, [[2, JSON.stringify(message), 91]]);
});

test("keeps the legacy numeric shortcut for WebSocket Apps without a stable route", () => {
  const appMessages = [];
  const routeCalls = [];
  const message = createMessage();
  const controller = {
    driver: {
      handleWsMessage(...args) {
        routeCalls.push(args);
      },
    },
    websocketAppClients: new Map([
      [
        2,
        {
          sendMessage: (message) => appMessages.push(message),
        },
      ],
    ]),
  };

  WebSocketController.prototype.sendMessageToApp.call(
    controller,
    2,
    JSON.stringify(message),
    91,
  );

  assert.deepEqual(appMessages, [JSON.stringify(message)]);
  assert.deepEqual(routeCalls, []);
});

test("late-binds a stable WebSocket App route once after its numeric id changes", () => {
  const staleRoute = createWebSocketApp(2, "other-app");
  const currentRoute = createWebSocketApp(10, "stable-app");
  const harness = createConnectorHarness([], [staleRoute, currentRoute]);

  dispatch(harness.connector, 2, "stable-app");

  assert.equal(staleRoute.messages.length, 0);
  assert.equal(currentRoute.messages.length, 1);
  const routed = JSON.parse(currentRoute.messages[0]);
  assert.equal(routed.debugRouterId, undefined);
  assert.equal(routed.data.data.client_id, 10);
  assert.equal(routed.to, 10);
  assert.deepEqual(harness.rejections, []);
});

test("sends a route rejection to one Driver instead of broadcasting", () => {
  const originMessages = [];
  const otherMessages = [];
  const controller = {
    webClients: new Map([
      [91, { sendMessage: (message) => originMessages.push(message) }],
      [92, { sendMessage: (message) => otherMessages.push(message) }],
    ]),
  };

  WebSocketController.prototype.sendMessageToDriver.call(
    controller,
    91,
    JSON.stringify({ event: "RouteRejected" }),
  );

  assert.equal(originMessages.length, 1);
  assert.equal(otherMessages.length, 0);
});

function createConnectorHarness(clients, webClients = []) {
  const rejections = [];
  return {
    connector: Object.assign(Object.create(DebugRouterConnector.prototype), {
      enableWebSocket: webClients.length > 0,
      usbClients: new Map(clients.map((client) => [client.clientId(), client])),
      wss: {
        getAllWebsocketAppClients() {
          return webClients;
        },
        sendMessageToDriver(id, rawMessage) {
          rejections.push({ id, message: JSON.parse(rawMessage) });
        },
      },
    }),
    rejections,
  };
}

function createWebSocketApp(id, debugRouterId, writable = true) {
  return {
    info: { raw_info: { debugRouterId } },
    messages: [],
    clientId: () => id,
    canSendMessage: () => writable,
    sendMessage(message) {
      this.messages.push(message);
    },
  };
}

function createUsbClient(id, debugRouterId, writable = true) {
  return {
    info: { query: { raw_info: { debugRouterId } } },
    messages: [],
    clientId: () => id,
    canSendMessage: () => writable,
    sendMessage(message) {
      this.messages.push(message);
    },
  };
}

function dispatch(connector, target, debugRouterId, origin = 91) {
  DebugRouterConnector.prototype.handleWsMessage.call(
    connector,
    target,
    JSON.stringify(createMessage(debugRouterId)),
    origin,
  );
}

function createMessage(debugRouterId) {
  return {
    event: "Customized",
    ...(debugRouterId === undefined ? {} : { debugRouterId }),
    data: {
      type: "CDP",
      data: {
        client_id: 2,
        message: JSON.stringify({ id: 7, method: "DOM.getDocument" }),
        session_id: 1,
      },
      sender: 91,
    },
    to: 2,
  };
}
