// Copyright 2026 The Lynx Authors. All rights reserved.
// Licensed under the Apache License, Version 2.0.

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFile } = require("child_process");
const { promisify } = require("util");
const run = promisify(execFile);
const validator = path.resolve(
  __dirname,
  "../../../debug_router_connector/dist/cjs/src/utils/hdc.validator.js"
);

// This executable fixture verifies the Connector's child-process cwd contract.
// It writes an ordinary relative file on exit; it does not simulate HDC memory
// corruption.
const fixture = `#!/usr/bin/env node
const fs = require("fs");
const command = process.argv.slice(2);
process.on("exit", () => {
  const file = "hdc-exit-" + process.pid + ".log";
  fs.writeFileSync(file, command.join(" "));
  fs.appendFileSync(process.env.HDC_TEST_EVENTS, JSON.stringify({
    command, file, cwd: process.cwd(), tmpdir: process.env.TMPDIR,
    sentinel: process.env.HDC_TEST_SENTINEL
  }) + "\\n");
});
if (command[0] === "--version") console.log("HDC cwd test fixture");
else if (command[0] === "start") process.exitCode = Number(process.env.HDC_TEST_EXIT);
else process.exitCode = 2;
`;

(process.platform === "win32" ? describe.skip : describe)(
  "HDC child working directory",
  function () {
    this.timeout(10000);

    for (const exitCode of [0, 1]) {
      it(`keeps relative exit logs outside the workspace when start exits ${exitCode}`, async function () {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), "hdc-cwd-test-"));
        try {
          const workspace = path.join(root, "workspace");
          const cache = path.join(root, "cache");
          const bin = path.join(root, "bin");
          const eventsFile = path.join(root, "events.jsonl");
          for (const dir of [workspace, cache, bin]) fs.mkdirSync(dir);
          fs.writeFileSync(path.join(bin, "hdc"), fixture, { mode: 0o755 });
          const { stdout } = await run(
            process.execPath,
            [
              "-e",
              `const { getHdcInstance } = require(${JSON.stringify(validator)});
               const before = process.cwd();
               getHdcInstance({}).then(() => {
                 if (process.cwd() !== before) throw new Error("Parent cwd changed");
                 console.log("HDC_CWD_TEST_OK");
               }).catch(error => { console.error(error); process.exitCode = 1; });`,
            ],
            {
              cwd: workspace,
              env: {
                ...process.env,
                PATH: bin + path.delimiter + process.env.PATH,
                TMPDIR: cache,
                HDC_TEST_EVENTS: eventsFile,
                HDC_TEST_SENTINEL: "preserved",
                HDC_TEST_EXIT: String(exitCode),
              },
              timeout: 5000,
            }
          );
          assert(stdout.includes("HDC_CWD_TEST_OK"));
          const events = fs
            .readFileSync(eventsFile, "utf8")
            .trim()
            .split("\n")
            .map(JSON.parse);
          assert.deepStrictEqual(
            events.map((event) => event.command),
            [["--version"], ["start"]]
          );
          assert.deepStrictEqual(fs.readdirSync(workspace), []);
          for (const event of events) {
            assert.strictEqual(
              path.dirname(fs.realpathSync(event.cwd)),
              fs.realpathSync(cache)
            );
            assert.strictEqual(event.tmpdir, cache);
            assert.strictEqual(event.sentinel, "preserved");
            assert.strictEqual(
              fs.readFileSync(path.join(event.cwd, event.file), "utf8"),
              event.command.join(" ")
            );
          }
        } finally {
          fs.rmSync(root, { recursive: true, force: true });
        }
      });
    }
  }
);
