// Copyright 2024 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

const path = require("path");
const { execFileSync } = require("child_process");

const findProcessModule = require(require.resolve("find-process", {
  paths: [path.join(__dirname, "../../../../debug_router_connector")],
}));
const findProcess = findProcessModule.default ?? findProcessModule;

async function findDaemonProcesses(daemonProcessName) {
  if (process.platform === "win32") {
    return findProcess("name", daemonProcessName, false);
  }

  try {
    return execFileSync(
      "pgrep",
      ["-f", `^${daemonProcessName}([[:space:]]|$)`],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }
    )
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .map(Number)
      .map((pid) => ({ pid }));
  } catch (_error) {
    return [];
  }
}

async function findDaemonProcess(daemonProcessName) {
  const processes = await findDaemonProcesses(daemonProcessName);
  return (
    processes.find((processInfo) => processExists(processInfo.pid)) ?? null
  );
}

async function stopDaemonProcesses(daemonProcessName) {
  const processes = await findDaemonProcesses(daemonProcessName);
  await Promise.all(
    processes.map((processInfo) => stopProcess(processInfo.pid))
  );
}

async function stopProcess(pid) {
  if (!processExists(pid)) {
    return;
  }
  try {
    process.kill(pid, "SIGTERM");
  } catch (_error) {}
  await waitForProcessExit(pid, 1000);
  if (!processExists(pid)) {
    return;
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch (_error) {}
  await waitForProcessExit(pid, 1000);
}

async function waitForProcessExit(pid, timeout) {
  const startedAt = Date.now();
  while (processExists(pid) && Date.now() - startedAt <= timeout) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

module.exports = {
  findDaemonProcess,
  stopDaemonProcesses,
};
