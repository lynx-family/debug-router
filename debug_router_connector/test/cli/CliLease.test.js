const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { CliLease } = require("../../dist/cjs/src/cli/CliLease.js");

describe("CliLease", () => {
  let stateDir;

  beforeEach(() => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "debug-router-lease-"));
  });

  afterEach(() => fs.rmSync(stateDir, { recursive: true, force: true }));

  it("serializes contenders and releases only its own token", async () => {
    const first = new CliLease({ stateDir, pollIntervalMs: 5 });
    const second = new CliLease({ stateDir, pollIntervalMs: 5 });
    await first.acquire(100);

    const waiting = second.acquire(100);
    setTimeout(() => first.release(), 15);
    await waiting;

    const owner = JSON.parse(
      fs.readFileSync(path.join(stateDir, "cli-lock", "owner.json"), "utf8"),
    );
    assert.strictEqual(owner.token, second.token);

    await first.release();
    assert.strictEqual(fs.existsSync(path.join(stateDir, "cli-lock")), true);
    await second.release();
    assert.strictEqual(fs.existsSync(path.join(stateDir, "cli-lock")), false);
  });

  it("times out while a live owner holds the lease", async () => {
    const first = new CliLease({ stateDir, pollIntervalMs: 5 });
    const second = new CliLease({ stateDir, pollIntervalMs: 5 });
    await first.acquire(100);

    await assert.rejects(second.acquire(15), /CONNECTOR_BUSY_TIMEOUT/);
    await first.release();
  });

  it("recovers a lock directory without an owner record", async () => {
    fs.mkdirSync(path.join(stateDir, "cli-lock"));
    const lease = new CliLease({ stateDir, pollIntervalMs: 5 });

    await lease.acquire(50);

    assert.strictEqual(lease.acquired, true);
    await lease.release();
  });

  it("recovers a stale owner", async () => {
    const lockDir = path.join(stateDir, "cli-lock");
    fs.mkdirSync(lockDir);
    fs.writeFileSync(
      path.join(lockDir, "owner.json"),
      JSON.stringify({ pid: 99999999, token: "stale" }),
    );
    const lease = new CliLease({ stateDir, pollIntervalMs: 5 });

    await lease.acquire(50);
    assert.strictEqual(lease.acquired, true);
    await lease.release();
  });
});
