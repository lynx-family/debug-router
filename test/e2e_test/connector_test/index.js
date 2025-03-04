const DebugRouterConnector = require("@lynx-js/debug-router-connector").DebugRouterConnector;

async function main() {
  // 1. cteate a debug router connector, named driver
  const driver = new DebugRouterConnector({
    manualConnect: true,
    enableWebSocket: false,
    enableAndroid: true,
    enableIOS: true,
    enableDesktop: false,
    websocketOption: {}
  });

  // 2. wait for devices connected, and then print the devices info
  // 6000 is the timeout
  const devicesArray = await driver.connectDevices(6000);
  console.log(devicesArray);

  // 3. connect to the first device, and then print all the client info
  // connectUsbClients(serial, timeout)
  const clients = await driver.connectUsbClients(devicesArray[0].serial, 6000);
  console.log(clients);

  // 4. chose the first client, and then print the client's raw_info
  const client = clients[0];
  console.log(client.info.query.raw_info);
  process.exit(0);
}

main();