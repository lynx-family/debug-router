// Copyright 2024 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

const assert = require("assert");
const { EventEmitter } = require("events");

const {
  WebSocketController,
} = require("../../../../debug_router_connector/dist/cjs/src/websocket/WebSocketServer");

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

function createClient(id, type = "Driver") {
  return {
    id,
    sent: [],
    closeCalls: 0,
    listCalls: 0,
    info: {
      type,
      raw_info: {
        app: `app-${id}`,
      },
    },
    clientId() {
      return id;
    },
    type() {
      return type;
    },
    sendMessage(message) {
      this.sent.push(message);
    },
    close() {
      this.closeCalls++;
    },
    handleListClients() {
      this.listCalls++;
    },
  };
}

function createController(hostOverrides = {}) {
  const calls = {
    emitted: [],
    handleWsMessage: [],
    handleWebSocketDriverMessage: [],
    handleWebSocketAppMessage: [],
    createClientId: 0,
  };
  const host = {
    createClientId() {
      calls.createClientId++;
      return 700 + calls.createClientId;
    },
    getAllUsbClients() {
      return [
        {
          info: {
            query: {
              raw_info: {
                app: "usb-app",
              },
              device: "device-1",
              os: "Android",
              device_model: "Pixel",
            },
          },
          clientId() {
            return 1;
          },
        },
      ];
    },
    async getDevices() {
      return [
        {
          serial: "device-1",
        },
      ];
    },
    emit(event, payload) {
      calls.emitted.push({
        event,
        payload,
      });
    },
    handleWsMessage(id, message) {
      calls.handleWsMessage.push({
        id,
        message,
      });
    },
    handleWebSocketDriverMessage(webClientId, targetClientId, message) {
      calls.handleWebSocketDriverMessage.push({
        webClientId,
        targetClientId,
        message,
      });
    },
    handleWebSocketAppMessage(appClientId, message) {
      calls.handleWebSocketAppMessage.push({
        appClientId,
        message,
      });
    },
    ...hostOverrides,
  };
  const controller = Object.create(WebSocketController.prototype);
  controller.controllerHost = host;
  controller.websocketAppClients = new Map();
  controller.webClients = new Map();
  controller.roomId = "room-1";
  return {
    controller,
    calls,
    host,
  };
}

describe("WebSocketController", function () {
  it("routes web-originated messages through the host instead of direct app delivery", function () {
    const { controller, calls } = createController();
    const app = createClient(10, "runtime");
    controller.websocketAppClients.set(10, app);

    controller.sendMessageToApp(10, "from-control");
    controller.sendMessageToApp(10, "from-web", 99);
    controller.sendMessageToApp(11, "to-usb");

    assert.deepStrictEqual(app.sent, ["from-control"]);
    assert.deepStrictEqual(calls.handleWebSocketDriverMessage, [
      {
        webClientId: 99,
        targetClientId: 10,
        message: "from-web",
      },
    ]);
    assert.deepStrictEqual(calls.handleWsMessage, [
      {
        id: 11,
        message: "to-usb",
      },
    ]);
  });

  it("falls back to legacy websocket app broadcasting when the host app-message hook is absent", function () {
    const { controller, calls } = createController({
      handleWebSocketAppMessage: undefined,
    });
    const firstWeb = createClient(1, "Driver");
    const secondWeb = createClient(2, "Driver");
    controller.webClients.set(1, firstWeb);
    controller.webClients.set(2, secondWeb);

    controller.handleWebSocketAppMessage(40, "app-message");

    assert.deepStrictEqual(firstWeb.sent, ["app-message"]);
    assert.deepStrictEqual(secondWeb.sent, ["app-message"]);
    assert.deepStrictEqual(calls.handleWebSocketAppMessage, []);
  });

  it("delegates websocket app messages to the host when the hook exists", function () {
    const { controller, calls } = createController();
    const web = createClient(1, "Driver");
    controller.webClients.set(1, web);

    controller.handleWebSocketAppMessage(40, "app-message");

    assert.deepStrictEqual(calls.handleWebSocketAppMessage, [
      {
        appClientId: 40,
        message: "app-message",
      },
    ]);
    assert.deepStrictEqual(web.sent, []);
  });

  it("sends messages to all web clients or one specific web client", function () {
    const { controller } = createController();
    const first = createClient(1, "Driver");
    const second = createClient(2, "Driver");
    controller.webClients.set(1, first);
    controller.webClients.set(2, second);

    controller.sendMessageToWeb("broadcast");
    controller.sendMessageToWebClient(2, "targeted");
    controller.sendMessageToWebClient(404, "missing");

    assert.deepStrictEqual(first.sent, ["broadcast"]);
    assert.deepStrictEqual(second.sent, ["broadcast", "targeted"]);
  });

  it("handles app and web disconnections, emits compatibility events, and refreshes web client lists", function () {
    const { controller, calls } = createController();
    const app = createClient(10, "runtime");
    const web = createClient(20, "Driver");
    const remainingWeb = createClient(21, "Driver");
    controller.websocketAppClients.set(10, app);
    controller.webClients.set(20, web);
    controller.webClients.set(21, remainingWeb);

    controller.handleDisconnect(10);
    controller.handleDisconnect(20);
    controller.handleDisconnect(404);

    assert.strictEqual(controller.websocketAppClients.has(10), false);
    assert.strictEqual(controller.webClients.has(20), false);
    assert.deepStrictEqual(
      calls.emitted.map((item) => item.event),
      [
        "websocket-app-client-disconnected",
        "app-client-disconnected",
        "websocket-web-client-disconnected",
      ]
    );
    assert.strictEqual(remainingWeb.listCalls, 3);
  });

  it("closes all tracked websocket clients without clearing the maps", function () {
    const { controller } = createController();
    const app = createClient(10, "runtime");
    const web = createClient(20, "Driver");
    controller.websocketAppClients.set(10, app);
    controller.webClients.set(20, web);

    controller.close();

    assert.strictEqual(app.closeCalls, 1);
    assert.strictEqual(web.closeCalls, 1);
    assert.strictEqual(controller.websocketAppClients.has(10), true);
    assert.strictEqual(controller.webClients.has(20), true);
  });

  it("accepts registered connections, sends RoomJoined, emits connection events, and refreshes lists", async function () {
    const { controller, calls } = createController();
    const socket = createSocket();
    controller.onConnection = async () => ({
      id: 30,
      app: "Demo",
      debugRouterVersion: "1.0.0",
      deviceModel: "Pixel",
      network: "WiFi",
      osVersion: "14",
      sdkVersion: "2.0.0",
      type: "Driver",
      raw_info: {
        app: "Demo",
      },
    });

    await controller.handleConnection(socket);

    assert.strictEqual(controller.webClients.has(30), true);
    assert.deepStrictEqual(JSON.parse(socket.sent[0]), {
      event: "RoomJoined",
      data: {
        room: "room-1",
        id: 30,
      },
    });
    assert.deepStrictEqual(calls.emitted, [
      {
        event: "websocket-web-client-connected",
        payload: controller.webClients.get(30),
      },
    ]);
  });

  it("accepts websocket app connections and closes sockets with invalid registration", async function () {
    const { controller, calls } = createController();
    const appSocket = createSocket();
    controller.onConnection = async () => ({
      id: 31,
      app: "Demo",
      debugRouterVersion: "1.0.0",
      deviceModel: "Pixel",
      network: "WiFi",
      osVersion: "14",
      sdkVersion: "2.0.0",
      type: "runtime",
      raw_info: {},
    });

    await controller.handleConnection(appSocket);
    assert.strictEqual(controller.websocketAppClients.has(31), true);
    assert.deepStrictEqual(
      calls.emitted.map((item) => item.event),
      ["websocket-app-client-connected", "app-client-connected"]
    );

    const rejectedSocket = createSocket();
    controller.onConnection = async () => undefined;
    await controller.handleConnection(rejectedSocket);
    assert.strictEqual(rejectedSocket.closeCalls, 1);
  });

  it("delegates usb clients, device snapshots, and emitted messages to the host", async function () {
    const { controller, calls } = createController();

    assert.deepStrictEqual(
      controller.getAllUsbClients().map((client) => client.clientId()),
      [1]
    );
    assert.deepStrictEqual(await controller.getAllDevices(), [
      {
        serial: "device-1",
      },
    ]);

    controller.emitEvent("ws-web-message", 1, "payload");
    assert.deepStrictEqual(calls.emitted[calls.emitted.length - 1], {
      event: "ws-web-message",
      payload: {
        id: 1,
        message: "payload",
      },
    });
  });
});
