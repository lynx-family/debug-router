const assert = require("assert");
const {
  DebugRouterConnector,
} = require("../../dist/cjs/src/connector/DebugRouterConnector.js");

function makeConnectorWithoutConstructor() {
  const connector = Object.create(DebugRouterConnector.prototype);
  connector.closed = false;
  connector.multiOpenMonitorTimer = setInterval(() => {}, 1000);
  connector.devicesManager = new Set();
  connector.devices = new Map();
  connector.usbClients = new Map();
  connector.wss = null;
  connector.traceRecorder = null;
  connector.disableAllClients = () => [];
  return connector;
}

describe("DebugRouterConnector lifecycle", () => {
  it("makes concurrent close callers await the same cleanup", async () => {
    const connector = makeConnectorWithoutConstructor();
    let finishManagerClose;
    connector.devicesManager.add({
      close: () => new Promise((resolve) => { finishManagerClose = resolve; }),
    });

    const first = connector.close();
    let secondFinished = false;
    const second = connector.close().then(() => { secondFinished = true; });
    await new Promise((resolve) => setImmediate(resolve));
    assert.strictEqual(secondFinished, false);

    finishManagerClose();
    await Promise.all([first, second]);
    assert.strictEqual(secondFinished, true);
  });

  it("continues cleanup when a manager close fails", async () => {
    const connector = makeConnectorWithoutConstructor();
    let deviceDisconnected = false;
    connector.devicesManager.add({ close: async () => { throw new Error("manager failed"); } });
    connector.devices.set("device", { disConnect: () => { deviceDisconnected = true; } });

    await assert.rejects(connector.close(), /manager failed/);

    assert.strictEqual(deviceDisconnected, true);
    assert.strictEqual(connector.devices.size, 0);
  });

  it("closes managers and devices exactly once", async () => {
    const connector = makeConnectorWithoutConstructor();
    let managerCloses = 0;
    let deviceDisconnects = 0;
    connector.devicesManager.add({
      close: async () => {
        managerCloses += 1;
      },
    });
    connector.devices.set("device", {
      disConnect: () => {
        deviceDisconnects += 1;
      },
    });

    await connector.close();
    await connector.close();

    assert.strictEqual(managerCloses, 1);
    assert.strictEqual(deviceDisconnects, 1);
    assert.strictEqual(connector.multiOpenMonitorTimer, undefined);
  });
});
