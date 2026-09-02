// Copyright 2024 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const test = require("node:test");
const {
  WebSocketController,
} = require("../dist/cjs/src/websocket/WebSocketServer.js");

class FakeSocket extends EventEmitter {
  constructor(info) {
    super();
    this.info = info;
    this.messages = [];
  }

  send(message) {
    this.messages.push(JSON.parse(message));
  }

  close() {
    this.emit("close");
  }
}

function createController(usbClients = []) {
  const controller = Object.create(WebSocketController.prototype);
  controller.driver = {
    emit() {},
    getAllUsbClients: () => usbClients,
    getDevices: async () => [],
  };
  controller.roomId = "test-room";
  controller.websocketAppClients = new Map();
  controller.webClients = new Map();
  controller.onConnection = async (socket) => socket.info;
  return controller;
}

function createSocket(id, type) {
  return new FakeSocket({
    id,
    app: "",
    debugRouterVersion: "",
    deviceModel: "",
    network: "WiFi",
    osVersion: "",
    sdkVersion: "",
    type,
    raw_info: { App: type === "Driver" ? "" : `app-${id}` },
  });
}

function clientLists(socket) {
  return socket.messages.filter((message) => message.event === "ClientList");
}

test("sends a new Driver only its own initial ClientList", async () => {
  const controller = createController();
  const firstDriver = createSocket(1, "Driver");
  const secondDriver = createSocket(2, "Driver");

  await controller.handleConnection(firstDriver);
  firstDriver.messages.length = 0;

  await controller.handleConnection(secondDriver);

  assert.deepStrictEqual(clientLists(firstDriver), []);
  assert.strictEqual(clientLists(secondDriver).length, 1);
});

test("does not broadcast ClientList when a Driver disconnects", async () => {
  const controller = createController();
  const firstDriver = createSocket(1, "Driver");
  const secondDriver = createSocket(2, "Driver");

  await controller.handleConnection(firstDriver);
  await controller.handleConnection(secondDriver);
  firstDriver.messages.length = 0;

  secondDriver.close();

  assert.deepStrictEqual(clientLists(firstDriver), []);
});

test("keeps App churn broadcasts and explicit ListClients responses", async () => {
  const controller = createController();
  const driver = createSocket(1, "Driver");
  const app = createSocket(2, "runtime");

  await controller.handleConnection(driver);
  driver.messages.length = 0;

  await controller.handleConnection(app);
  assert.deepStrictEqual(clientLists(driver), [
    {
      event: "ClientList",
      data: [
        {
          id: 2,
          type: "runtime",
          info: { App: "app-2", network: "WiFi" },
        },
      ],
    },
  ]);

  driver.messages.length = 0;
  driver.emit("message", Buffer.from(JSON.stringify({ event: "ListClients" })));
  assert.strictEqual(clientLists(driver).length, 1);

  driver.messages.length = 0;
  app.close();
  assert.deepStrictEqual(clientLists(driver), [
    { event: "ClientList", data: [] },
  ]);
});

test("keeps USB route change broadcasts", async () => {
  const usbClients = [];
  const controller = createController(usbClients);
  const firstDriver = createSocket(1, "Driver");
  const secondDriver = createSocket(2, "Driver");

  await controller.handleConnection(firstDriver);
  await controller.handleConnection(secondDriver);
  firstDriver.messages.length = 0;
  secondDriver.messages.length = 0;

  usbClients.push({
    clientId: () => 3,
    info: {
      query: {
        raw_info: { App: "usb-app" },
        device: "USB Device",
        os: "Android",
        device_model: "Test Model",
      },
    },
  });
  controller.sendClientList();

  for (const driver of [firstDriver, secondDriver]) {
    assert.deepStrictEqual(clientLists(driver), [
      {
        event: "ClientList",
        data: [
          {
            id: 3,
            type: "runtime",
            info: {
              App: "usb-app",
              deviceName: "USB Device",
              osType: "Android",
              deviceModel: "Test Model",
              network: "USB",
            },
          },
        ],
      },
    ]);
  }
});
