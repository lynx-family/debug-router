const assert = require("assert");
const { Writable } = require("stream");
const { main } = require("../../dist/cjs/src/cli/main.js");

class Capture extends Writable {
  constructor() {
    super();
    this.value = "";
  }
  _write(chunk, encoding, callback) {
    this.value += chunk.toString();
    callback();
  }
}

function dependencies(overrides = {}) {
  const session = {
    open: async () => {},
    discover: async () => ({ devices: [], clients: [] }),
    resolveTarget: () => ({
      info: { port: 8901 },
      deviceId: () => "device",
    }),
    send: async () => ({ id: 1, result: {} }),
    listen: async () => {},
    close: async () => {},
    ...overrides.session,
  };
  return {
    leaseFactory: () => ({ acquire: async () => {}, release: async () => {} }),
    guardFactory: () => ({ wait: async () => {} }),
    sessionFactory: () => session,
    ...overrides,
  };
}

describe("debug-router CLI", () => {
  it("writes one JSON object for list", async () => {
    const stdout = new Capture();
    const stderr = new Capture();
    const code = await main(["list"], dependencies(), { stdout, stderr });
    assert.strictEqual(code, 0);
    assert.deepStrictEqual(JSON.parse(stdout.value), {
      devices: [],
      clients: [],
    });
    assert.strictEqual(stderr.value, "");
  });

  it("rejects Network and malformed params as usage errors", async () => {
    for (const argv of [
      ["list", "--platform", "network"],
      ["send", "--method", "Runtime.enable", "--params", "[]"],
      ["send", "--type", "app", "--method", "App.reload", "--session-id", "1"],
      ["install-skill", "--target", "unknown"],
    ]) {
      const stdout = new Capture();
      const stderr = new Capture();
      const code = await main(argv, dependencies(), { stdout, stderr });
      assert.strictEqual(code, 2);
      assert.strictEqual(stdout.value, "");
      assert.strictEqual(JSON.parse(stderr.value).error.code, "USAGE_ERROR");
    }
  });

  it("uses a five-second default send timeout", async () => {
    const stdout = new Capture();
    const stderr = new Capture();
    let timeout;
    const code = await main(
      ["send", "--method", "Runtime.enable"],
      dependencies({
        session: {
          send: async (_client, _method, _params, _sessionId, _type, value) => {
            timeout = value;
            return { id: 1, result: {} };
          },
        },
      }),
      { stdout, stderr },
    );

    assert.strictEqual(code, 0);
    assert.strictEqual(timeout, 5000);
  });

  it("writes send response JSON and passes explicit takeover", async () => {
    const stdout = new Capture();
    const stderr = new Capture();
    let takeover;
    const deps = dependencies({
      guardFactory: () => ({
        wait: async (_timeout, value) => {
          takeover = value;
        },
      }),
      session: {
        discover: async () => ({
          devices: [{ id: "d" }],
          clients: [{ id: "d:8901" }],
        }),
      },
    });
    const code = await main(
      ["send", "--method", "Runtime.enable", "--takeover"],
      deps,
      { stdout, stderr },
    );
    assert.strictEqual(code, 0);
    assert.strictEqual(takeover, true);
    assert.deepStrictEqual(JSON.parse(stdout.value).response, {
      id: 1,
      result: {},
    });
  });

  it("cancels while waiting for the CLI lease", async () => {
    const stdout = new Capture();
    const stderr = new Capture();
    const controller = new AbortController();
    let released = false;
    const pending = main(
      ["list"],
      dependencies({
        leaseFactory: () => ({
          acquire: async (_timeout, signal) =>
            new Promise((resolve, reject) => {
              signal.addEventListener(
                "abort",
                () =>
                  reject(
                    Object.assign(new Error("aborted"), { name: "AbortError" }),
                  ),
                { once: true },
              );
            }),
          release: async () => {
            released = true;
          },
        }),
      }),
      { stdout, stderr, signal: controller.signal, signalExitCode: 130 },
    );
    setTimeout(() => controller.abort(), 5);

    assert.strictEqual(await pending, 130);
    assert.strictEqual(released, true);
  });

  it("releases the lease when session cleanup fails", async () => {
    const stdout = new Capture();
    const stderr = new Capture();
    let released = false;
    const code = await main(
      ["list"],
      dependencies({
        leaseFactory: () => ({
          acquire: async () => {},
          release: async () => {
            released = true;
          },
        }),
        session: {
          close: async () => {
            throw new Error("close failed");
          },
        },
      }),
      { stdout, stderr },
    );

    assert.strictEqual(code, 1);
    assert.strictEqual(released, true);
    assert.strictEqual(stdout.value, "");
    assert.strictEqual(JSON.parse(stderr.value).error.code, "CLEANUP_FAILED");
  });

  it("cancels listening and cleans up when aborted", async () => {
    const stdout = new Capture();
    const stderr = new Capture();
    const controller = new AbortController();
    let closed = false;
    const deps = dependencies({
      session: {
        listen: async () => new Promise(() => {}),
        close: async () => {
          closed = true;
        },
      },
    });
    const pending = main(["listen"], deps, {
      stdout,
      stderr,
      signal: controller.signal,
      signalExitCode: 130,
    });
    setTimeout(() => controller.abort(), 5);

    const code = await pending;

    assert.strictEqual(code, 130);
    assert.strictEqual(closed, true);
  });

  it("renders version without creating a session", async () => {
    const stdout = new Capture();
    const stderr = new Capture();
    let created = false;
    const code = await main(
      ["--version"],
      dependencies({
        sessionFactory: () => {
          created = true;
          throw new Error("unexpected");
        },
      }),
      { stdout, stderr },
    );

    assert.strictEqual(code, 0);
    assert.match(stdout.value, /^0\.0\.1\n$/);
    assert.strictEqual(created, false);
  });

  it("renders help without creating a session", async () => {
    const stdout = new Capture();
    const stderr = new Capture();
    let created = false;
    const code = await main(
      ["--help"],
      dependencies({
        sessionFactory: () => {
          created = true;
          throw new Error("unexpected");
        },
      }),
      { stdout, stderr },
    );

    assert.strictEqual(code, 0);
    assert.match(stdout.value, /list/);
    assert.strictEqual(created, false);
  });

  it("installs the Skill without acquiring Connector ownership", async () => {
    const stdout = new Capture();
    const stderr = new Capture();
    let acquired = false;
    let installOptions;
    const code = await main(
      ["install-skill", "--target", "codex", "--force"],
      dependencies({
        leaseFactory: () => ({
          acquire: async () => {
            acquired = true;
          },
          release: async () => {},
        }),
        installSkill: (options) => {
          installOptions = options;
          return { installed: true, path: "/tmp/skill", version: "1" };
        },
      }),
      { stdout, stderr },
    );

    assert.strictEqual(code, 0);
    assert.strictEqual(acquired, false);
    assert.deepStrictEqual(installOptions, { force: true, target: "codex" });
    assert.strictEqual(JSON.parse(stdout.value).installed, true);
  });

  it("maps preemption to exit code 4 and stderr", async () => {
    const stdout = new Capture();
    const stderr = new Capture();
    const error = new Error("CONNECTOR_PREEMPTED: taken");
    error.code = "CONNECTOR_PREEMPTED";
    const code = await main(
      ["list"],
      dependencies({
        session: {
          discover: async () => {
            throw error;
          },
        },
      }),
      { stdout, stderr },
    );
    assert.strictEqual(code, 4);
    assert.strictEqual(stdout.value, "");
    assert.strictEqual(
      JSON.parse(stderr.value).error.code,
      "CONNECTOR_PREEMPTED",
    );
  });
});
