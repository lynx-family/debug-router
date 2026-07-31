const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const { parseArgs } = require("../../scripts/install-agents.cjs");

describe("install:agents bootstrap", () => {
  it("builds an executable CLI entrypoint", () => {
    if (process.platform === "win32") {
      return;
    }
    const mode = fs.statSync(
      path.join(__dirname, "../../dist/cjs/src/cli/bin.js"),
    ).mode;
    assert.notStrictEqual(mode & 0o111, 0);
  });

  it("uses the shared Agents target by default", () => {
    assert.deepStrictEqual(parseArgs([]), {
      target: "agents",
      force: false,
    });
  });

  it("accepts target and force options", () => {
    assert.deepStrictEqual(parseArgs(["--target", "codex", "--force"]), {
      target: "codex",
      force: true,
    });
    assert.deepStrictEqual(parseArgs(["--target=all"]), {
      target: "all",
      force: false,
    });
  });

  it("rejects unsupported bootstrap options", () => {
    assert.throws(() => parseArgs(["--target", "unknown"]), /Invalid --target/);
    assert.throws(() => parseArgs(["--unknown"]), /Unknown option/);
    assert.throws(() => parseArgs(["--target"]), /requires a value/);
  });

  it("does not install a Skill when npm setup fails", () => {
    const root = fs.mkdtempSync(
      path.join(fs.realpathSync(os.tmpdir()), "debug-router-bootstrap-fail-"),
    );
    const home = path.join(root, "home");
    fs.mkdirSync(home);
    try {
      const result = spawnSync(
        process.execPath,
        [path.join(__dirname, "../../scripts/install-agents.cjs")],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            HOME: home,
            npm_execpath: path.join(root, "missing-npm-cli.js"),
          },
        },
      );
      assert.notStrictEqual(result.status, 0);
      assert.strictEqual(
        fs.existsSync(path.join(home, ".agents", "skills", "debug-router")),
        false,
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
