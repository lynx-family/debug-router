const assert = require("assert");
const { EventEmitter } = require("events");
const {
  DebugRouterSession,
  makeClientId,
} = require("../../dist/cjs/src/cli/DebugRouterSession.js");

class FakeClient {
  constructor(id, deviceId, port, app = "app") {
    this.info = {
      id,
      port,
      query: {
        device_id: deviceId,
        os: "Android",
        device: "Pixel",
        device_model: "Pixel",
        app,
        sdk_version: "1.0",
        raw_info: { secret: true },
      },
    };
    this.events = new EventEmitter();
  }
  deviceId() { return this.info.query.device_id; }
  clientId() { return this.info.id; }
  onAllEvents(callback) { this.events.on("all", callback); }
  offAllEvents(callback) { this.events.off("all", callback); }
  sendCustomizedMessage(method, params, sessionId, type) {
    return Promise.resolve(JSON.stringify({ id: 1, result: { method, params, sessionId, type } }));
  }
}

class FakeConnector {
  constructor(options, devices, clients) {
    this.options = options;
    this.devices = new Map(devices.map((device) => [device.info.serial, device]));
    this.clients = clients;
    this.events = new EventEmitter();
    this.closed = false;
  }
  setMultiOpenCallback(callback) { this.multiOpen = callback; }
  connectDevices() { return Promise.resolve([...this.devices.values()]); }
  connectUsbClients(deviceId) {
    return Promise.resolve(this.clients.filter((client) => client.deviceId() === deviceId));
  }
  on(event, callback) { this.events.on(event, callback); }
  off(event, callback) { this.events.off(event, callback); }
  close() { this.closed = true; return Promise.resolve(); }
}

function device(serial, os = "Android", title = "Pixel") {
  return { info: { serial, os, title } };
}

describe("DebugRouterSession", () => {
  it("builds sorted snapshots with stable opaque client IDs", async () => {
    const clients = [new FakeClient(2, "b/device", 8902), new FakeClient(1, "a", 8901)];
    let connector;
    const session = new DebugRouterSession((options) => {
      connector = new FakeConnector(options, [device("b/device"), device("a")], clients);
      return connector;
    });

    await session.open(["android"]);
    const snapshot = await session.discover(10);

    assert.deepStrictEqual(snapshot.devices.map((item) => item.id), ["a", "b/device"]);
    assert.deepStrictEqual(snapshot.clients.map((item) => item.id), ["a:8901", "b%2Fdevice:8902"]);
    assert.strictEqual("raw_info" in snapshot.clients[0], false);
    assert.strictEqual(connector.options.enableNetworkDevice, false);
  });

  it("requires one exact target", async () => {
    const clients = [new FakeClient(1, "a", 8901), new FakeClient(2, "a", 8902)];
    const session = new DebugRouterSession(() => new FakeConnector({}, [device("a")], clients));
    await session.open(["android"]);
    await session.discover(10);

    assert.throws(() => session.resolveTarget({ deviceId: "a" }), /TARGET_AMBIGUOUS/);
    assert.throws(() => session.resolveTarget({ clientId: "missing" }), /TARGET_NOT_FOUND/);
    assert.strictEqual(session.resolveTarget({ clientId: makeClientId("a", 8902) }), clients[1]);
  });

  it("removes an active listener when the session closes", async () => {
    const target = new FakeClient(1, "a", 8901);
    const session = new DebugRouterSession(() => new FakeConnector({}, [device("a")], [target]));
    await session.open(["android"]);
    await session.discover(10);
    const listening = session.listen(target, () => {});

    await session.close();
    await listening;

    assert.strictEqual(target.events.listenerCount("all"), 0);
  });

  it("fails listening when the target disconnects", async () => {
    const target = new FakeClient(1, "a", 8901);
    let connector;
    const session = new DebugRouterSession(() => {
      connector = new FakeConnector({}, [device("a")], [target]);
      return connector;
    });
    await session.open(["android"]);
    await session.discover(10);
    const listening = session.listen(target, () => {});

    connector.events.emit("client-disconnected", 1);

    await assert.rejects(listening, /TARGET_DISCONNECTED/);
    assert.strictEqual(target.events.listenerCount("all"), 0);
  });

  it("fails pending work when another connector preempts it", async () => {
    let connector;
    const session = new DebugRouterSession(() => {
      connector = new FakeConnector({}, [], []);
      connector.connectDevices = () => new Promise(() => {});
      return connector;
    });
    await session.open(["android"]);
    const pending = session.discover(1000);

    connector.multiOpen.statusChanged(1);

    await assert.rejects(pending, /CONNECTOR_PREEMPTED/);
    await session.close();
    assert.strictEqual(connector.closed, true);
  });
});
