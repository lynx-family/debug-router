// Copyright 2026 The Lynx Authors. All rights reserved.
// Licensed under the Apache License, Version 2.0.

const assert = require("assert");
const net = require("net");
const rewire = require("../../../debug_router_connector/node_modules/rewire");
const {
  Adb,
} = require("../../../debug_router_connector/node_modules/@devicefarmer/adbkit");

describe("Android ADB forward isolation", function () {
  let module, AndroidDevice, servers, sockets, restoreMath;

  beforeEach(() => {
    module = rewire(
      "../../../debug_router_connector/dist/cjs/src/device/android/AndroidDevice"
    );
    AndroidDevice = module.default;
    restoreMath = module.__set__(
      "Math",
      Object.assign(Object.create(Math), { random: () => 0 })
    );
    servers = [];
    sockets = new Set();
  });

  afterEach(async () => {
    restoreMath();
    sockets.forEach((socket) => socket.destroy());
    await Promise.all(
      servers.map((server) => new Promise((resolve) => server.close(resolve)))
    );
  });

  async function listen(handle) {
    const server = net.createServer((socket) => {
      sockets.add(socket);
      socket.on("error", () => {});
      socket.on("close", () => sockets.delete(socket));
      if (handle) handle(socket);
    });
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    servers.push(server);
    return server.address().port;
  }

  async function fakeAdb(forwards = new Map()) {
    let collisions = 0;
    const frame = (value) =>
      Buffer.byteLength(value).toString(16).padStart(4, "0") + value;
    const port = await listen((socket) => {
      let data = Buffer.alloc(0);
      socket.on("data", (chunk) => {
        data = Buffer.concat([data, chunk]);
        if (data.length < 4) return;
        const length = parseInt(data.subarray(0, 4).toString(), 16);
        if (data.length < length + 4) return;
        const command = data.subarray(4, length + 4).toString();
        if (command.endsWith(":list-forward")) {
          const list = [...forwards]
            .map(
              ([local, { serial, remote }]) => `${serial} ${local} ${remote}\n`
            )
            .join("");
          socket.end("OKAY" + frame(list));
          return;
        }
        const match = /^host-serial:(.*):forward:(norebind:)?(tcp:\d+);(tcp:\d+)$/.exec(
          command
        );
        if (!match) {
          socket.end("FAIL" + frame("unexpected command: " + command));
          return;
        }
        const [, serial, norebind, local, remote] = match;
        if (forwards.has(local) && norebind) {
          collisions++;
          socket.end("OKAYFAIL" + frame("cannot rebind existing socket"));
        } else {
          forwards.set(local, { serial, remote });
          socket.end("OKAYOKAY");
        }
      });
    });
    return {
      adb: Adb.createClient({ host: "127.0.0.1", port }),
      forwards,
      get collisions() {
        return collisions;
      },
    };
  }

  function device(adb, serial) {
    const value = new AndroidDevice({}, serial, serial, adb);
    value.remotePorts = [8901];
    value.adbForwardRemove = async () => {};
    return value;
  }

  it("does not select an existing IPv4 loopback listener", async () => {
    const occupied = await listen();
    AndroidDevice.localBasePort = occupied - 1;
    const server = await fakeAdb();
    const value = device(server.adb, "cloud");
    await value.forwards();
    assert.strictEqual(value.ports.length, 1);
    assert.notStrictEqual(value.ports[0], occupied);
    assert.strictEqual(server.forwards.has(`tcp:${occupied}`), false);
  });

  it("retries a concurrent port collision without replacing the other device", async () => {
    // Both devices see the same free candidate before ADB creates either forward.
    module.__set__("detect_port_1", {
      default: async (config) => config.port || config,
    });
    const server = await fakeAdb();
    const first = device(server.adb, "redmi");
    const second = device(server.adb, "10.76.222.246:35989");
    await Promise.all([first.forwards(), second.forwards()]);
    assert.strictEqual(server.collisions, 1);
    assert.strictEqual(server.forwards.size, 2);
    assert.notStrictEqual(first.ports[0], second.ports[0]);
    for (const value of [first, second]) {
      assert.deepStrictEqual(server.forwards.get(`tcp:${value.ports[0]}`), {
        serial: value.serial,
        remote: "tcp:8901",
      });
    }
  });

  it("removes only the current device's SDK forwards and selects its serial", async () => {
    const serial = "10.76.222.246:35989";
    const server = await fakeAdb(
      new Map([
        ["tcp:19501", { serial: "redmi", remote: "tcp:8901" }],
        ["tcp:19502", { serial, remote: "tcp:8901" }],
        ["tcp:19503", { serial, remote: "tcp:9222" }],
      ])
    );
    const value = new AndroidDevice({}, serial, "cloud", server.adb);
    const commands = [];
    value.exeCmd = async (command) => {
      commands.push(command);
      return "";
    };
    await value.adbForwardRemove(server.adb.getDevice(serial));
    assert.strictEqual(commands.length, 1);
    assert(
      commands[0].endsWith(
        ` -H 127.0.0.1 -P ${server.adb.options.port} -s ${serial} forward --remove tcp:19502`
      )
    );
  });
});
