const assert = require("assert");
const connector = require("../dist/cjs/src/index.js");

describe("package exports", () => {
  it("keeps the existing connector API available", () => {
    assert.strictEqual(typeof connector.DebugRouterConnector, "function");
    assert.strictEqual(typeof connector.UsbClient, "function");
    assert.strictEqual(typeof connector.defaultLogger, "object");
  });
});
