// Trace verification script for ConnectionTraceRecorder
const DebugRouterConnector = require("@lynx-js/debug-router-connector").DebugRouterConnector;
const fs = require("fs");
const path = require("path");

const TRACE_FILE = path.join(__dirname, "connection-trace.jsonl");

// Clean up previous trace file
if (fs.existsSync(TRACE_FILE)) {
  fs.unlinkSync(TRACE_FILE);
}

async function main() {
  console.log("Starting trace test...");
  console.log("Trace output:", TRACE_FILE);

  const driver = new DebugRouterConnector({
    manualConnect: true,
    enableWebSocket: false,
    enableAndroid: true,
    enableIOS: true,
    enableHarmony: true,
    enableDesktop: false,
    connectionTrace: {
      enabled: true,
      output: TRACE_FILE,
    },
  });

  console.log("Waiting for devices (6s)...");
  const devicesArray = await driver.connectDevices(6000);
  if (devicesArray.length === 0) {
    console.error("No devices found. Make sure a phone is connected.");
    process.exit(1);
  }

  console.log(`Found ${devicesArray.length} device(s):`);
  devicesArray.forEach((d) => console.log(`  ${d.info.serial} (${d.info.os}) - ${d.info.title}`));

  const serial = devicesArray[0].serial;
  console.log(`\nConnecting USB clients on device: ${serial} (6s timeout)...`);
  const clients = await driver.connectUsbClients(serial, 6000);

  if (clients.length === 0) {
    console.log("No USB clients found on device.");
  } else {
    console.log(`Found ${clients.length} client(s):`);
    clients.forEach((c) =>
      console.log(
        `  clientId=${c.clientId()} app=${c.info.query.app} os=${c.info.query.os}`,
      ),
    );
  }

  // Give a moment for all trace writes to flush
  await new Promise((r) => setTimeout(r, 200));

  // Print trace nodes
  console.log("\n--- Trace nodes ---");
  if (fs.existsSync(TRACE_FILE)) {
    const lines = fs.readFileSync(TRACE_FILE, "utf-8").trim().split("\n").filter(Boolean);
    lines.forEach((line) => {
      try {
        const node = JSON.parse(line);
        const parent = node.parentId ? ` (parent: ${node.parentId})` : "";
        const device = node.deviceId ? ` [device: ${node.deviceId}]` : "";
        const meta = node.metadata ? ` ${JSON.stringify(node.metadata)}` : "";
        console.log(`  [${node.id}] ${node.event}${device}${parent}${meta}`);
      } catch (e) {
        console.log("  (unparseable):", line);
      }
    });
    console.log(`\nTotal: ${lines.length} trace node(s) written to ${TRACE_FILE}`);
  } else {
    console.error("Trace file was not created!");
  }

  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
