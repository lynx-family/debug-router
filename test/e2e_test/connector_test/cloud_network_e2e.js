#!/usr/bin/env node
// Copyright 2026 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.
//
// Manual-only cloud-device E2E; intentionally excluded from npm scripts and CI.
// Build debug_router_connector before running. The endpoint must expose the
// DebugRouter SDK TCP service, not ADB. The example must support the E2E App/CDP
// Ping handlers and CDP notification; the default example session ID is 1.
// Reports and traces are written outside the checkout under the OS temp dir.
const fs = require("fs");
const os = require("os");
const path = require("path");
const net = require("net");
const assert = require("assert/strict");
const { execFileSync } = require("child_process");
function printHelp() {
  console.log(`Usage:
  node test/e2e_test/connector_test/cloud_network_e2e.js --ip <SDK_IP> --port <SDK_PORT|START-END> [--session-id <ID>]

Options:
  --ip          Required SDK endpoint IP (IPv4 or IPv6 literal).
  --port        Required SDK TCP port or inclusive range, e.g. 8901-8920.
  --session-id  Example CDP session ID; defaults to 1.
  --help        Print this help without connecting to a device.

Checks: shared network registration, SDK handshake, ten concurrent-pair App
requests, and a CDP reply with one notification on each Connector.
Results and connection traces are saved in a unique OS temporary directory.`);
}

function parseArgs(argv) {
  const options = { ip: "", port: "", sessionId: 1 };
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (
      !["--ip", "--port", "--session-id"].includes(flag) ||
      !value ||
      value.startsWith("--")
    ) {
      throw new Error(
        `Invalid or missing argument: ${flag}. Use --help for usage.`
      );
    }
    if (flag === "--ip") options.ip = value;
    if (flag === "--port") options.port = value;
    if (flag === "--session-id") options.sessionId = Number(value);
  }
  assert(net.isIP(options.ip), "--ip must be an IP literal");
  assert(
    /^\d+(?:-\d+)?$/.test(options.port),
    "--port must be a port or START-END range"
  );
  const [start, end = start] = options.port.split("-").map(Number);
  assert(
    start >= 1 && end <= 65535 && start <= end,
    "--port must be an ascending range within 1-65535"
  );
  options.ports = Array.from(
    { length: end - start + 1 },
    (_, index) => start + index
  );
  assert(
    Number.isSafeInteger(options.sessionId) && options.sessionId >= 0,
    "--session-id must be a non-negative integer"
  );
  return options;
}

if (process.argv.includes("--help")) {
  printHelp();
  process.exit(0);
}
const args = parseArgs(process.argv.slice(2));
const repoRoot = path.resolve(__dirname, "../../..");
const pkg = path.join(repoRoot, "debug_router_connector");
const { DebugRouterConnector } = require(pkg);
const { createMultiplexerPaths } = require(path.join(
  pkg,
  "dist/cjs/src/multiplexer/utils/paths"
));
const { stopDaemonProcesses } = require("./multiplexer/daemon_process");
const runId = new Date().toISOString().replace(/[:.]/g, "-");
const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "cloud-network-e2e-"));
const reportPath = path.join(outputDir, "result.json");
const tracePath = path.join(outputDir, "trace.jsonl");
console.log(`Test artifacts: ${outputDir}`);
const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cloud-mux-"));
const paths = createMultiplexerPaths({ rootDir });
const report = {
  startedAt: new Date().toISOString(),
  target: `${args.ip}:${args.port}`,
  repo: repoRoot,
  commit: execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: repoRoot,
    encoding: "utf8",
  }).trim(),
  rootDir,
  tracePath,
  stages: [],
  success: false,
};
const connectors = [];
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function timeout(promise, ms, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} timed out after ${ms}ms`)),
          ms
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
async function waitFor(fn, ms, label) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const value = fn();
    if (value) return value;
    await pause(100);
  }
  throw new Error(`${label} timed out after ${ms}ms`);
}
async function stage(name, fn) {
  const started = Date.now();
  console.log(`START ${name}`);
  try {
    const detail = await fn();
    report.stages.push({
      name,
      status: "passed",
      elapsedMs: Date.now() - started,
      detail,
    });
    console.log(`PASS ${name}`, JSON.stringify(detail ?? null));
    return detail;
  } catch (error) {
    report.stages.push({
      name,
      status: "failed",
      elapsedMs: Date.now() - started,
      error: error.stack,
    });
    console.error(`FAIL ${name}: ${error.message}`);
    throw error;
  }
}
function hasMarker(value, marker) {
  if (value === marker) return true;
  if (typeof value === "string") {
    try {
      return hasMarker(JSON.parse(value), marker);
    } catch {
      return false;
    }
  }
  return (
    value &&
    typeof value === "object" &&
    Object.values(value).some((item) => hasMarker(item, marker))
  );
}
function createConnector() {
  const connector = new DebugRouterConnector({
    connectionTrace: { enabled: true, output: tracePath },
    manualConnect: true,
    enableAndroid: false,
    enableIOS: false,
    enableHarmony: false,
    enableDesktop: false,
    enableNetworkDevice: true,
    enableWebSocket: false,
    multiplexerRootDir: rootDir,
    multiplexerLegacyDriverDir: path.join(rootDir, "legacy"),
    multiplexerDaemonIdleTimeout: 1000,
    multiplexerStartupTimeout: 10000,
    multiplexerRpcTimeout: 10000,
  });
  connectors.push(connector);
  return connector;
}
async function tcpDiagnostic(port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: args.ip, port });
    let done = false;
    function finish(result) {
      if (done) return;
      done = true;
      socket.destroy();
      resolve({ port, ...result });
    }
    socket.setTimeout(5000, () =>
      finish({ reachable: false, error: "TCP timeout after 5000ms" })
    );
    socket.once("connect", () =>
      finish({
        reachable: true,
        note:
          "TCP reachability alone does not prove a DebugRouter SDK handshake.",
      })
    );
    socket.once("error", (error) =>
      finish({ reachable: false, error: error.message })
    );
  });
}
async function main() {
  try {
    const first = createConnector(),
      peer = createConnector();
    const options = { ip: args.ip, port: args.ports };
    const deviceEvents = [];
    first.on("device-connected", (device) => deviceEvents.push(device.serial));
    await stage("Concurrent watchNetworkDeviceAtIp registration", async () => {
      await timeout(
        Promise.all([
          first.watchNetworkDeviceAtIp(options),
          peer.watchNetworkDeviceAtIp(options),
        ]),
        15000,
        "network watch"
      );
      await waitFor(
        () => connectors.every((c) => c.devices.has(args.ip)),
        5000,
        "device mirrors"
      );
      await first.watchNetworkDeviceAtIp(options);
      assert.equal(deviceEvents.filter((ip) => ip === args.ip).length, 1);
      for (const c of connectors)
        assert.deepEqual(c.devices.get(args.ip).ports, args.ports);
      return { deviceEvents, ports: first.devices.get(args.ip).ports };
    });
    const runtime = await stage(
      "Real cloud SDK registration and runtime discovery",
      async () => {
        await waitFor(
          () =>
            connectors.every((c) =>
              c
                .getAllUsbClients()
                .some((client) => client.deviceId() === args.ip)
            ),
          30000,
          "cloud SDK runtime registration"
        );
        const lists = await Promise.all(
          connectors.map((c) => c.connectUsbClients(args.ip))
        );
        assert(lists[0].length > 0);
        const firstClient = lists[0][0];
        const peerClient = lists[1].find(
          (client) => client.clientId() === firstClient.clientId()
        );
        assert(
          peerClient,
          "Both connectors must mirror the same daemon runtime"
        );
        report.runtime = firstClient.info;
        console.log("SDK INFO", JSON.stringify(firstClient.info));
        return {
          clientId: firstClient.clientId(),
          deviceId: firstClient.deviceId(),
          app: firstClient.info.query?.app,
        };
      }
    );
    const runtimeClients = connectors.map((c) =>
      c
        .getAllUsbClients()
        .find((client) => client.clientId() === runtime.clientId)
    );
    await stage(
      "Concurrent App debug requests through both connectors",
      async () => {
        let success = 0;
        for (let round = 0; round < 5; round++) {
          await Promise.all(
            runtimeClients.map(async (client, index) => {
              const marker = `${runId}-app-${round}-${index}`;
              const raw = await timeout(
                client.sendClientMessage("ConnectorRealDeviceE2E.Ping", {
                  marker,
                }),
                10000,
                `App ping ${marker}`
              );
              assert(
                hasMarker(raw, marker),
                `App reply did not echo expected marker: ${JSON.stringify(raw)}`
              );
              success++;
            })
          );
        }
        return { success, expected: 10 };
      }
    );
    await stage(
      "Session CDP debug request and notification fanout",
      async () => {
        const marker = `${runId}-cdp`;
        const notifications = [[], []];
        const handlers = runtimeClients.map((_, index) => (params) => {
          if (hasMarker(params, marker)) notifications[index].push(params);
        });
        runtimeClients.forEach((client, index) =>
          client.on("ConnectorRealDeviceE2E.CDP.Notification", handlers[index])
        );
        try {
          const raw = await timeout(
            runtimeClients[0].sendCustomizedMessage(
              "ConnectorRealDeviceE2E.CDP.Ping",
              { marker },
              args.sessionId,
              "CDP"
            ),
            10000,
            "CDP ping"
          );
          assert(
            hasMarker(raw, marker),
            `CDP reply did not echo marker: ${JSON.stringify(raw)}`
          );
          await waitFor(
            () => notifications.every((items) => items.length >= 1),
            5000,
            "notification fanout"
          );
          await pause(300);
          assert.deepEqual(
            notifications.map((items) => items.length),
            [1, 1]
          );
          return {
            sessionId: args.sessionId,
            reply: JSON.parse(raw),
            notificationCounts: [1, 1],
          };
        } finally {
          runtimeClients.forEach((client, index) =>
            client.off(
              "ConnectorRealDeviceE2E.CDP.Notification",
              handlers[index]
            )
          );
        }
      }
    );
    report.success = true;
  } catch (error) {
    report.error = error.stack;
    report.tcpDiagnostic = await Promise.all(args.ports.map(tcpDiagnostic));
    console.log("TCP DIAGNOSTIC", JSON.stringify(report.tcpDiagnostic));
    process.exitCode = 1;
  } finally {
    try {
      await Promise.all(
        connectors.map((c) => timeout(c.close(), 5000, "connector close"))
      );
      await stopDaemonProcesses(paths.daemonProcessName);
      fs.rmSync(rootDir, { recursive: true, force: true });
    } catch (error) {
      report.cleanupError = error.stack;
      report.success = false;
      process.exitCode = 1;
    }
    report.finishedAt = new Date().toISOString();
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n");
    console.log(report.success ? "TEST SUCCESS" : "TEST FAILED", reportPath);
  }
}

main().catch((error) => {
  console.error("TEST RUNNER FAILED", error);
  process.exitCode = 1;
});
