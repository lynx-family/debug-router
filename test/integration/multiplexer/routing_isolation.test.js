// Copyright 2024 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

const assert = require("assert");

const {
  connectDriverWebSocket,
  createCustomizedEnvelope,
  createCustomizedResponseEnvelope,
  createIntegrationContext,
  delay,
  parseCustomizedEnvelope,
  platformTimeout,
  waitFor,
  waitForSocketMessage,
} = require("./helpers/integration_harness");

describe("multiplexer integration routing isolation", function () {
  this.timeout(platformTimeout(12000));

  let context;

  afterEach(async function () {
    if (context) {
      await context.cleanup();
      context = undefined;
    }
  });

  it("routes duplicate WebSocket request ids back only to the originating frontend", async function () {
    context = createIntegrationContext("routing-websocket", {
      enableWebSocket: true,
      websocketOption: {
        port: 0,
        roomId: "integration-room",
      },
    });

    const client = context.createClient({ rpcTimeout: 1500 });
    const controlEvents = [];
    client.subscribe((event) => controlEvents.push(event));
    await client.connect();
    await client.call("connectDevices", {
      timeout: -1,
      serial: null,
      isAutoListenClients: true,
    });
    await client.call("connectUsbClients", {
      deviceId: "device-1",
      timeout: -1,
      waitTimeout: true,
      clientName: null,
    });
    const serverInfo = await client.call("startWSServer", {});
    assert(serverInfo.port > 0);

    const url = `ws://127.0.0.1:${serverInfo.port}/mdevices/page/android`;
    const webA = await connectDriverWebSocket(url, { app: "driver-a" });
    const webB = await connectDriverWebSocket(url, { app: "driver-b" });
    context.trackSocket(webA.socket);
    context.trackSocket(webB.socket);

    const responseA = waitForSocketMessage(webA.socket, (value) => {
      if (value?.event !== "Customized") {
        return false;
      }
      const parsed = parseCustomizedEnvelope(JSON.stringify(value));
      return parsed.cdp.result?.params?.marker === "web-a";
    });
    const responseB = waitForSocketMessage(webB.socket, (value) => {
      if (value?.event !== "Customized") {
        return false;
      }
      const parsed = parseCustomizedEnvelope(JSON.stringify(value));
      return parsed.cdp.result?.params?.marker === "web-b";
    });

    webA.socket.send(createCustomizedEnvelope(1, 1, "web-a"));
    webB.socket.send(createCustomizedEnvelope(1, 1, "web-b"));

    const [a, b] = await Promise.all([responseA, responseB]);
    const parsedA = parseCustomizedEnvelope(a.text);
    const parsedB = parseCustomizedEnvelope(b.text);
    assert.strictEqual(parsedA.cdp.id, 1);
    assert.strictEqual(parsedB.cdp.id, 1);
    assert.deepStrictEqual(parsedA.cdp.result.params, { marker: "web-a" });
    assert.deepStrictEqual(parsedB.cdp.result.params, { marker: "web-b" });

    const unexpectedA = [];
    const unexpectedB = [];
    webA.socket.on("message", (data) => {
      const parsed = parseMaybeCustomized(data.toString());
      if (parsed?.cdp?.result?.params?.marker === "web-b") {
        unexpectedA.push(parsed);
      }
    });
    webB.socket.on("message", (data) => {
      const parsed = parseMaybeCustomized(data.toString());
      if (parsed?.cdp?.result?.params?.marker === "web-a") {
        unexpectedB.push(parsed);
      }
    });
    await delay(100);
    assert.deepStrictEqual(unexpectedA, []);
    assert.deepStrictEqual(unexpectedB, []);
  });

  it("keeps control and WebSocket routes separate when they use the same original request id", async function () {
    context = createIntegrationContext("routing-control-websocket", {
      enableWebSocket: true,
      websocketOption: {
        port: 0,
        roomId: "integration-room",
      },
    });

    const client = context.createClient({ rpcTimeout: 1500 });
    const controlEvents = [];
    client.subscribe((event) => controlEvents.push(event));
    await client.connect();
    await client.call("connectDevices", {
      timeout: -1,
      serial: null,
      isAutoListenClients: true,
    });
    await client.call("connectUsbClients", {
      deviceId: "device-1",
      timeout: -1,
      waitTimeout: true,
      clientName: null,
    });
    const serverInfo = await client.call("startWSServer", {});
    const web = await connectDriverWebSocket(
      `ws://127.0.0.1:${serverInfo.port}/mdevices/page/android`,
      { app: "driver-control-mix" }
    );
    context.trackSocket(web.socket);

    const webResponse = waitForSocketMessage(web.socket, (value) => {
      if (value?.event !== "Customized") {
        return false;
      }
      return (
        parseCustomizedEnvelope(JSON.stringify(value)).cdp.result?.params
          ?.marker === "web-route"
      );
    });

    const controlResponse = waitFor(() => {
      return controlEvents.find((event) => {
        if (
          event.event !== "client-message" ||
          event.data.source !== "usb-runtime"
        ) {
          return false;
        }
        return (
          parseCustomizedEnvelope(event.data.message).cdp.result?.params
            ?.marker === "control-route"
        );
      });
    }, 2000);

    web.socket.send(createCustomizedEnvelope(1, 1, "web-route"));
    await client.call("sendMessageWithoutReply", {
      target: "app",
      clientId: 1,
      message: createCustomizedEnvelope(1, 1, "control-route"),
    });

    const [webMessage, controlEvent] = await Promise.all([
      webResponse,
      controlResponse,
    ]);
    const webParsed = parseCustomizedEnvelope(webMessage.text);
    const controlParsed = parseCustomizedEnvelope(controlEvent.data.message);

    assert.strictEqual(webParsed.cdp.id, 1);
    assert.strictEqual(controlParsed.cdp.id, 1);
    assert.deepStrictEqual(webParsed.cdp.result.params, {
      marker: "web-route",
    });
    assert.deepStrictEqual(controlParsed.cdp.result.params, {
      marker: "control-route",
    });
    await waitFor(() => {
      const sentMessages = context
        .readLog()
        .filter((entry) => entry.event === "client-send-message");
      return (
        sentMessages.filter(
          (entry) => entry.id === 1 && entry.message?.event === "Customized"
        ).length >= 2
      );
    }, 2000);
  });

  it("routes duplicate control request ids back only to the originating control connection", async function () {
    context = createIntegrationContext("routing-control-control", {
      enableWebSocket: false,
    });

    const controlA = context.createClient({ rpcTimeout: 1500 });
    const controlB = context.createClient({
      manager: context.createManager(),
      rpcTimeout: 1500,
    });
    const eventsA = [];
    const eventsB = [];
    controlA.subscribe((event) => eventsA.push(event));
    controlB.subscribe((event) => eventsB.push(event));
    await Promise.all([controlA.connect(), controlB.connect()]);
    await controlA.call("connectDevices", {
      timeout: -1,
      serial: null,
      isAutoListenClients: true,
    });
    await controlA.call("connectUsbClients", {
      deviceId: "device-1",
      timeout: -1,
      waitTimeout: true,
      clientName: null,
    });

    const responseA = waitFor(() =>
      eventsA.find(
        (event) =>
          event.event === "client-message" &&
          event.data.source === "usb-runtime" &&
          parseCustomizedEnvelope(event.data.message).cdp.result?.params
            ?.marker === "control-a"
      )
    );
    const responseB = waitFor(() =>
      eventsB.find(
        (event) =>
          event.event === "client-message" &&
          event.data.source === "usb-runtime" &&
          parseCustomizedEnvelope(event.data.message).cdp.result?.params
            ?.marker === "control-b"
      )
    );

    await Promise.all([
      controlA.call("sendMessageWithoutReply", {
        target: "app",
        clientId: 1,
        message: createCustomizedEnvelope(1, 1, "control-a"),
      }),
      controlB.call("sendMessageWithoutReply", {
        target: "app",
        clientId: 1,
        message: createCustomizedEnvelope(1, 1, "control-b"),
      }),
    ]);

    const [eventA, eventB] = await Promise.all([responseA, responseB]);
    const parsedA = parseCustomizedEnvelope(eventA.data.message);
    const parsedB = parseCustomizedEnvelope(eventB.data.message);
    assert.strictEqual(parsedA.cdp.id, 1);
    assert.strictEqual(parsedB.cdp.id, 1);
    assert.deepStrictEqual(parsedA.cdp.result.params, { marker: "control-a" });
    assert.deepStrictEqual(parsedB.cdp.result.params, { marker: "control-b" });
    assert.strictEqual(
      eventsA.some(
        (event) =>
          event.event === "client-message" &&
          event.data.source === "usb-runtime" &&
          event.data.message.includes("control-b")
      ),
      false
    );
    assert.strictEqual(
      eventsB.some(
        (event) =>
          event.event === "client-message" &&
          event.data.source === "usb-runtime" &&
          event.data.message.includes("control-a")
      ),
      false
    );
  });

  it("drops unknown response ids but broadcasts notifications to control clients", async function () {
    context = createIntegrationContext("routing-unknown", {
      enableWebSocket: false,
    });

    const client = context.createClient({ rpcTimeout: 1500 });
    const controlEvents = [];
    client.subscribe((event) => controlEvents.push(event));
    await client.connect();

    context.appendCommand({
      type: "emit-usb-message",
      id: 1,
      message: createCustomizedResponseEnvelope(1, 999, "unknown-response"),
    });
    await waitFor(() =>
      context.readLog().some((entry) => entry.event === "emit-usb-message")
    );
    await delay(100);
    assert.strictEqual(
      controlEvents.some(
        (event) =>
          event.event === "client-message" &&
          event.data.source === "usb-runtime" &&
          event.data.message.includes("unknown-response")
      ),
      false
    );

    const notification = JSON.stringify({
      event: "Customized",
      data: {
        type: "CDP",
        data: {
          message: JSON.stringify({
            method: "Runtime.consoleAPICalled",
            params: { marker: "notification" },
          }),
        },
        sender: 0,
      },
    });
    context.appendCommand({
      type: "emit-usb-message",
      id: 1,
      message: notification,
    });

    await waitFor(() =>
      controlEvents.some(
        (event) =>
          event.event === "client-message" &&
          event.data.source === "usb-runtime" &&
          event.data.message.includes("notification")
      )
    );
  });
});

function parseMaybeCustomized(text) {
  try {
    const value = JSON.parse(text);
    if (value?.event !== "Customized") {
      return null;
    }
    return parseCustomizedEnvelope(text);
  } catch (_error) {
    return null;
  }
}
