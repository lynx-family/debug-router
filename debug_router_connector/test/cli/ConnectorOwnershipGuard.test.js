const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  ConnectorOwnershipGuard,
} = require("../../dist/cjs/src/cli/ConnectorOwnershipGuard.js");

describe("ConnectorOwnershipGuard", () => {
  let stateDir;

  beforeEach(() => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "debug-router-owner-"));
  });

  afterEach(() => fs.rmSync(stateDir, { recursive: true, force: true }));

  it("returns immediately without an owner", async () => {
    const guard = new ConnectorOwnershipGuard({ stateDir, pollIntervalMs: 5 });
    await guard.wait(20, false);
  });

  it("times out for a live owner", async () => {
    fs.writeFileSync(path.join(stateDir, "LatestDriverProcess"), `${process.pid}`);
    const guard = new ConnectorOwnershipGuard({ stateDir, pollIntervalMs: 5 });
    await assert.rejects(guard.wait(15, false), /CONNECTOR_BUSY_TIMEOUT/);
  });

  it("bypasses the owner wait for one explicit takeover", async () => {
    fs.writeFileSync(path.join(stateDir, "LatestDriverProcess"), `${process.pid}`);
    const guard = new ConnectorOwnershipGuard({ stateDir, pollIntervalMs: 5 });
    await guard.wait(15, true);
  });

  it("ignores stale owner records", async () => {
    fs.writeFileSync(path.join(stateDir, "LatestDriverProcess"), "99999999");
    const guard = new ConnectorOwnershipGuard({ stateDir, pollIntervalMs: 5 });
    await guard.wait(20, false);
  });
});
