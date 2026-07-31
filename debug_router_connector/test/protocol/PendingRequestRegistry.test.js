const assert = require("assert");
const {
  PendingRequestRegistry,
} = require("../../dist/cjs/src/protocol/PendingRequestRegistry.js");

describe("PendingRequestRegistry", () => {
  it("resolves and removes a registered request", async () => {
    const registry = new PendingRequestRegistry();
    const pending = registry.register("1");

    assert.strictEqual(registry.resolve("1", "ok"), true);
    assert.strictEqual(await pending, "ok");
    assert.strictEqual(registry.size, 0);
  });

  it("rejects duplicate keys without replacing the first request", async () => {
    const registry = new PendingRequestRegistry();
    const first = registry.register("1");

    await assert.rejects(registry.register("1"), /already pending/);
    registry.resolve("1", "first");
    assert.strictEqual(await first, "first");
  });

  it("times out and removes a request", async () => {
    const registry = new PendingRequestRegistry();
    const pending = registry.register("1", 10);

    await assert.rejects(pending, /timed out/);
    assert.strictEqual(registry.size, 0);
  });

  it("rejects all requests exactly once", async () => {
    const registry = new PendingRequestRegistry();
    const first = registry.register("1");
    const second = registry.register("2");

    registry.rejectAll(new Error("closed"));
    registry.rejectAll(new Error("closed again"));

    await assert.rejects(first, /closed/);
    await assert.rejects(second, /closed/);
    assert.strictEqual(registry.size, 0);
  });

  it("returns false for unknown keys", () => {
    const registry = new PendingRequestRegistry();
    assert.strictEqual(registry.resolve("missing", "value"), false);
    assert.strictEqual(registry.reject("missing", new Error("no")), false);
  });
});
