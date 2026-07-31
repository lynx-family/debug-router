const assert = require("assert");
const { EventEmitter } = require("events");
const { UsbClient } = require("../../dist/cjs/src/usb/Client.js");

class FakeConnection {
  constructor(response) {
    this.response = response;
    this.events = new EventEmitter();
    this.sent = [];
  }
  close() {}
  send() {}
  async sendExpectResponse(message, timeoutMs) {
    this.sent.push({ message, timeoutMs });
    return this.response;
  }
  on(event, callback) { this.events.on(event, callback); }
  off(event, callback) { this.events.off(event, callback); }
  once(event, callback) { this.events.once(event, callback); }
  onAllEvents(callback) { this.events.on("all", callback); }
  offAllEvents(callback) { this.events.off("all", callback); }
  emitAll(method, params, metadata) { this.events.emit("all", method, params, metadata); }
}

function client(connection) {
  return new UsbClient({
    id: 1,
    port: 8901,
    query: {
      app: "app",
      os: "Android",
      device: "Pixel",
      device_model: "Pixel",
      device_id: "device",
    },
  }, connection);
}

describe("UsbClient protocol integration", () => {
  it("serializes CDP requests and parses the nested response", async () => {
    const connection = new FakeConnection({
      event: "Customized",
      data: { type: "CDP", data: { message: JSON.stringify({ id: 1, result: { ok: true } }) } },
    });
    const usbClient = client(connection);

    const response = await usbClient.sendCustomizedMessage("Runtime.enable", {}, 7, "CDP", 123);

    assert.deepStrictEqual(JSON.parse(response).result, { ok: true });
    assert.strictEqual(connection.sent[0].message.data.data.session_id, 7);
    assert.strictEqual(connection.sent[0].message.data.data.message.method, "Runtime.enable");
    assert.strictEqual(connection.sent[0].timeoutMs, 123);
  });

  it("serializes App requests with the App type", async () => {
    const connection = new FakeConnection({
      event: "Customized",
      data: { type: "App", data: { message: JSON.stringify({ id: 2, result: {} }) } },
    });
    const usbClient = client(connection);

    await usbClient.sendClientMessage("App.reload", {});

    assert.strictEqual(connection.sent[0].message.data.type, "App");
    assert.strictEqual(connection.sent[0].message.data.data.session_id, -1);
  });

  it("delivers and removes all-event listeners", () => {
    const connection = new FakeConnection(null);
    const usbClient = client(connection);
    const received = [];
    const listener = (...args) => received.push(args);
    usbClient.onAllEvents(listener);
    connection.emitAll("Runtime.event", { value: 1 }, { session_id: 3 });
    usbClient.offAllEvents(listener);
    connection.emitAll("Runtime.event", { value: 2 }, { session_id: 3 });

    assert.strictEqual(received.length, 1);
    assert.strictEqual(received[0][0], "Runtime.event");
  });

  it("rejects unexpected response types", async () => {
    const connection = new FakeConnection({ event: "Customized", data: { type: "Other", data: {} } });
    await assert.rejects(client(connection).sendCustomizedMessage("Runtime.enable"), /Unexpected/);
  });
});
