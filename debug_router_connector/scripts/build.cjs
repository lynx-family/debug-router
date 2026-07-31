#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const packageRoot = path.resolve(__dirname, "..");
const outputDirectory = path.join(packageRoot, "dist");
const tsc = require.resolve("typescript/bin/tsc", { paths: [packageRoot] });

fs.rmSync(outputDirectory, { recursive: true, force: true });
const result = spawnSync(
  process.execPath,
  [
    tsc,
    "--project",
    "tsconfig.json",
    "--module",
    "CommonJS",
    "--outDir",
    "./dist/cjs",
  ],
  {
    cwd: packageRoot,
    stdio: "inherit",
  },
);

if (result.error) {
  throw result.error;
}
if (result.signal) {
  process.stderr.write(`TypeScript build terminated by ${result.signal}\n`);
  process.exitCode = 1;
} else if (result.status === 0) {
  fs.chmodSync(
    path.join(outputDirectory, "cjs", "src", "cli", "bin.js"),
    0o755,
  );
  process.exitCode = 0;
} else {
  process.exitCode = result.status ?? 1;
}
