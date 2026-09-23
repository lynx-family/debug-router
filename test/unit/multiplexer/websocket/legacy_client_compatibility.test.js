// Copyright 2026 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

const assert = require("assert");
const { EventEmitter } = require("events");
const {
  UsbClient,
} = require("../../../../debug_router_connector/dist/cjs/src/usb/Client");
const {
  WebSocketClient,
} = require("../../../../debug_router_connector/dist/cjs/src/websocket/WebSocketConnection");
const {
  WebSocketController,
} = require("../../../../debug_router_connector/dist/cjs/src/websocket/WebSocketServer");

function createRuntime(handleWebSocketAppMessage) {
  const emitted = [];
  const broadcast = [];
  const controller = Object.create(WebSocketController.prototype);
  controller.controllerHost = {
    emit: (event, payload) => emitted.push({ event, payload }),
    ...(handleWebSocketAppMessage ? { handleWebSocketAppMessage } : {}),
  };
  controller.webClients = new Map([
    [1, { sendMessage: (message) => broadcast.push(message) }],
  ]);
  controller.websocketAppClients = new Map();
  const socket = new EventEmitter();
  socket.sent = [];
  socket.send = (message) => socket.sent.push(JSON.parse(message));
  const client = new WebSocketClient(
    controller,
    { id: 42, type: "runtime" },
    socket
  );
  return { client, socket, emitted, broadcast };
}

function responseFor(request, value) {
  return JSON.stringify({
    ...request,
    data: {
      ...request.data,
      data: {
        ...request.data.data,
        message: JSON.stringify({
          id: request.data.data.message.id,
          result: value,
        }),
      },
    },
  });
}

describe("legacy Client API compatibility before facade migration", function () {
  it("keeps USB request replies and event subscriptions functional", async function () {
    const connection = new EventEmitter();
    const requests = [];
    connection.sendExpectResponse = async (request) => {
      requests.push(request);
      return JSON.parse(responseFor(request, request.data.type));
    };
    const client = new UsbClient(
      { id: 7, query: { device_id: "device-1" } },
      connection
    );
    const cdp = await client.sendCustomizedMessage("Runtime.enable", {}, 3);
    const app = await client.sendClientMessage("GetGlobalSwitch", {});
    assert.strictEqual(JSON.parse(cdp).result, "CDP");
    assert.strictEqual(JSON.parse(app).result, "App");
    assert.strictEqual(requests[0].data.data.session_id, 3);
    assert.strictEqual(requests[1].data.data.message.method, "GetGlobalSwitch");

    const events = [];
    const listener = (value) => events.push(value);
    client.on("notification", listener);
    client.once("notification", (value) => events.push(`once:${value}`));
    connection.emit("notification", "first");
    client.off("notification", listener);
    connection.emit("notification", "second");
    assert.deepStrictEqual(events, ["first", "once:first"]);
  });

  it("matches legacy WebSocket replies out of order and preserves raw runtime events", async function () {
    const { client, socket, emitted, broadcast } = createRuntime();
    const first = client.sendCustomizedMessage("Runtime.enable", {}, 3);
    const second = client.sendCustomizedMessage("Runtime.evaluate", {
      expression: "1 + 1",
    });
    assert.strictEqual(socket.sent.length, 2);
    const firstReply = responseFor(socket.sent[0], "enabled");
    const secondReply = responseFor(socket.sent[1], 2);
    socket.emit("message", secondReply);
    socket.emit("message", firstReply);

    const replies = await Promise.all([first, second]);
    assert.deepStrictEqual(
      replies.map((reply) => JSON.parse(reply).result),
      ["enabled", 2]
    );
    assert.strictEqual(client.pendingRequests.size, 0);
    assert.deepStrictEqual(
      emitted,
      [secondReply, firstReply].map((message) => ({
        event: "ws-client-message",
        payload: { id: 42, message },
      }))
    );
    assert.deepStrictEqual(broadcast, [secondReply, firstReply]);
  });

  it("keeps daemon-owned responses on the Host routing path without legacy broadcasts", function () {
    const routed = [];
    const { socket, emitted, broadcast } = createRuntime((id, message) => {
      routed.push({ id, message });
    });
    const message = JSON.stringify({
      event: "Customized",
      data: {
        type: "CDP",
        sender: 0,
        data: {
          client_id: 42,
          message: JSON.stringify({ id: 123, result: {} }),
        },
      },
    });
    socket.emit("message", message);

    assert.deepStrictEqual(routed, [{ id: 42, message }]);
    assert.deepStrictEqual(emitted, []);
    assert.deepStrictEqual(broadcast, []);
  });
});
