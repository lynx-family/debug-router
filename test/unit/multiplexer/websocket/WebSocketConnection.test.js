// Copyright 2024 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

const assert = require("assert");
const { EventEmitter } = require("events");

const {
  WebSocketClient,
} = require("../../../../debug_router_connector/dist/cjs/src/websocket/WebSocketConnection");

function createSocket() {
  const socket = new EventEmitter();
  socket.sent = [];
  socket.closeCalls = 0;
  socket.send = (message) => socket.sent.push(message);
  socket.close = () => {
    socket.closeCalls++;
    socket.emit("close");
  };
  return socket;
}

function createInfo(id, type = "Driver", rawInfo = {}) {
  return {
    id,
    app: rawInfo.app ?? `app-${id}`,
    debugRouterVersion: rawInfo.debugRouterVersion ?? "1.0.0",
    deviceModel: rawInfo.deviceModel ?? "Pixel",
    network: "WiFi",
    osVersion: rawInfo.osVersion ?? "14",
    sdkVersion: rawInfo.sdkVersion ?? "2.0.0",
    type,
    raw_info: rawInfo,
  };
}

function createUsbClient(id) {
  return {
    info: {
      query: {
        raw_info: {
          app: `usb-${id}`,
        },
        device: `device-${id}`,
        os: "Android",
        device_model: "Pixel",
      },
    },
    clientId() {
      return id;
    },
  };
}

function createServer() {
  const calls = {
    emitted: [],
    sendMessageToApp: [],
    sendMessageToWeb: [],
    handleWebSocketAppMessage: [],
    disconnects: [],
  };
  const appClients = new Map();
  const usbClients = [createUsbClient(7)];
  return {
    calls,
    appClients,
    usbClients,
    getAllWebsocketAppClients() {
      return appClients;
    },
    getAllUsbClients() {
      return usbClients;
    },
    emitEvent(event, id, message) {
      calls.emitted.push({
        event,
        id,
        message,
      });
    },
    sendMessageToApp(id, message, fromWebClientId) {
      calls.sendMessageToApp.push({
        id,
        message,
        fromWebClientId,
      });
    },
    sendMessageToWeb(message) {
      calls.sendMessageToWeb.push(message);
    },
    handleWebSocketAppMessage(id, message) {
      calls.handleWebSocketAppMessage.push({
        id,
        message,
      });
    },
    handleDisconnect(id) {
      calls.disconnects.push(id);
    },
  };
}

function createCustomizedMessage({
  id = 1,
  method = "Runtime.evaluate",
  params = {},
  result,
  clientId = -1,
  sender = 0,
}) {
  const inner =
    result === undefined
      ? {
          id,
          method,
          params,
        }
      : {
          id,
          result,
        };
  return {
    event: "Customized",
    data: {
      type: "CDP",
      data: {
        client_id: clientId,
        session_id: -1,
        message: JSON.stringify(inner),
      },
      sender,
    },
  };
}

describe("WebSocketClient", function () {
  it("sends Driver Customized messages to the target app with the originating web client id", function () {
    const server = createServer();
    const socket = createSocket();
    new WebSocketClient(server, createInfo(100, "Driver"), socket);
    const message = JSON.stringify(
      createCustomizedMessage({
        id: 1,
        clientId: 50,
      })
    );

    socket.emit("message", message);

    assert.deepStrictEqual(server.calls.emitted, [
      {
        event: "ws-web-message",
        id: 100,
        message,
      },
    ]);
    assert.deepStrictEqual(server.calls.sendMessageToApp, [
      {
        id: 50,
        message,
        fromWebClientId: 100,
      },
    ]);
    assert.deepStrictEqual(server.calls.handleWebSocketAppMessage, []);
  });

  it("does not forward Driver Customized messages without a target client id", function () {
    const server = createServer();
    const socket = createSocket();
    new WebSocketClient(server, createInfo(101, "Driver"), socket);

    socket.emit(
      "message",
      JSON.stringify(
        createCustomizedMessage({
          clientId: -1,
        })
      )
    );

    assert.deepStrictEqual(server.calls.sendMessageToApp, []);
  });

  it("routes runtime Customized messages through handleWebSocketAppMessage", function () {
    const server = createServer();
    const socket = createSocket();
    new WebSocketClient(server, createInfo(200, "runtime"), socket);
    const message = JSON.stringify(
      createCustomizedMessage({
        id: 2,
        sender: 100,
      })
    );

    socket.emit("message", message);

    assert.deepStrictEqual(server.calls.emitted, []);
    assert.deepStrictEqual(server.calls.handleWebSocketAppMessage, [
      {
        id: 200,
        message,
      },
    ]);
    assert.deepStrictEqual(server.calls.sendMessageToWeb, []);
  });

  it("does not delegate runtime Customized messages without a sender", function () {
    const server = createServer();
    const socket = createSocket();
    new WebSocketClient(server, createInfo(201, "runtime"), socket);

    socket.emit(
      "message",
      JSON.stringify(
        createCustomizedMessage({
          sender: -1,
        })
      )
    );

    assert.strictEqual(server.calls.handleWebSocketAppMessage.length, 0);
  });

  it("handles ListClients and Ping for Driver clients", function () {
    const server = createServer();
    const socket = createSocket();
    const appSocket = createSocket();
    const appClient = new WebSocketClient(
      server,
      createInfo(300, "runtime", {
        app: "runtime-app",
      }),
      appSocket
    );
    server.appClients.set(300, appClient);
    new WebSocketClient(server, createInfo(301, "Driver"), socket);

    socket.emit("message", JSON.stringify({ event: "ListClients" }));
    socket.emit("message", JSON.stringify({ event: "Ping" }));

    assert.deepStrictEqual(JSON.parse(socket.sent[0]), {
      event: "ClientList",
      data: [
        {
          id: 300,
          type: "runtime",
          info: {
            app: "runtime-app",
            network: "WiFi",
          },
        },
        {
          id: 7,
          type: "runtime",
          info: {
            app: "usb-7",
            deviceName: "device-7",
            osType: "Android",
            deviceModel: "Pixel",
            network: "USB",
          },
        },
      ],
    });
    assert.deepStrictEqual(JSON.parse(socket.sent[1]), {
      event: "Pong",
    });
  });

  it("ignores ListClients and Ping replies for runtime clients", function () {
    const server = createServer();
    const socket = createSocket();
    new WebSocketClient(server, createInfo(400, "runtime"), socket);

    socket.emit("message", JSON.stringify({ event: "ListClients" }));
    socket.emit("message", JSON.stringify({ event: "Ping" }));

    assert.deepStrictEqual(socket.sent, []);
  });

  it("parses Buffer messages through the same routing branch", function () {
    const server = createServer();
    const socket = createSocket();
    new WebSocketClient(server, createInfo(500, "Driver"), socket);
    const message = JSON.stringify(
      createCustomizedMessage({
        id: 10,
        clientId: 77,
      })
    );

    socket.emit("message", Buffer.from(message));

    assert.deepStrictEqual(server.calls.sendMessageToApp, [
      {
        id: 77,
        message,
        fromWebClientId: 500,
      },
    ]);
  });

  it("notifies the server when the socket closes", function () {
    const server = createServer();
    const socket = createSocket();
    new WebSocketClient(
      server,
      createInfo(700, "Driver"),
      socket
    );

    socket.emit("close");

    assert.deepStrictEqual(server.calls.disconnects, [700]);
  });

});
