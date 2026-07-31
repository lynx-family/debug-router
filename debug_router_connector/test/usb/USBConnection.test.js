const assert = require("assert");
const { EventEmitter } = require("events");
const {
  USBConnection,
} = require("../../dist/cjs/src/usb/USBConnection.js");

class FakeSocket extends EventEmitter {
  constructor() {
    super();
    this.writable = true;
    this.writes = [];
    this.endCalls = 0;
  }

  write(data) {
    this.writes.push(data);
    return true;
  }

  end() {
    this.endCalls += 1;
    this.writable = false;
  }
}

function customized(id = 1) {
  return {
    event: "Customized",
    data: {
      type: "CDP",
      data: { message: { id, method: "Runtime.enable", params: {} } },
    },
  };
}

describe("USBConnection", () => {
  it("does not send a duplicate pending request", async () => {
    const socket = new FakeSocket();
    const connection = new USBConnection(socket);
    const first = connection.sendExpectResponse(customized(1), 10);

    await assert.rejects(connection.sendExpectResponse(customized(1), 10), /already pending/);
    assert.strictEqual(socket.writes.length, 1);
    await assert.rejects(first, /timed out/);
  });

  it("rejects serialization failures through the Promise API", async () => {
    const socket = new FakeSocket();
    const connection = new USBConnection(socket);
    const request = customized(1);
    request.data.data.message.params = { value: BigInt(1) };

    const pending = connection.sendExpectResponse(request, 100);

    await assert.rejects(pending, /BigInt/);
  });

  it("rejects immediately when the socket is not writable", async () => {
    const socket = new FakeSocket();
    socket.writable = false;
    const connection = new USBConnection(socket);

    await assert.rejects(
      connection.sendExpectResponse(customized(), 100),
      /not writable/,
    );
  });

  it("rejects a request after its timeout", async () => {
    const socket = new FakeSocket();
    const connection = new USBConnection(socket);

    await assert.rejects(
      connection.sendExpectResponse(customized(), 10),
      /timed out/,
    );
  });

  for (const event of ["error", "close"]) {
    it(`rejects pending requests on socket ${event}`, async () => {
      const socket = new FakeSocket();
      const connection = new USBConnection(socket);
      const pending = connection.sendExpectResponse(customized(), 1000);

      socket.emit(event, event === "error" ? new Error("socket failed") : undefined);

      await assert.rejects(pending, /closed|socket failed/);
    });
  }

  it("rejects pending requests on explicit close and closes once", async () => {
    const socket = new FakeSocket();
    const connection = new USBConnection(socket);
    const pending = connection.sendExpectResponse(customized(), 1000);

    connection.close();
    connection.close();

    await assert.rejects(pending, /closed/);
    assert.strictEqual(socket.endCalls, 1);
  });
});
