const DebugRouterConnector = require("@lynx-js/debug-router-connector").DebugRouterConnector;
 
const util = require('./util.js');

async function main() {
  const driver = new DebugRouterConnector({
    manualConnect: true,
    enableWebSocket: false,
    enableAndroid: true,
    enableIOS: true,
    enableDesktop: false,
    websocketOption: {}
  });

  const startActivity = 'adb shell am start -n com.lynx.debugrouter.testapp/com.lynx.debugrouter.testapp.MainActivity'
  util.exec(startActivity, 10000).then((data) => {
    console.log("startActivity:" + data);
  }).catch((reason) => {
    console.log("startActivity FAILED:" + reason);
    process.exit(-1);
  })

  const devicesArray = await driver.connectDevices(6000);
  console.log(devicesArray);

  const clients = await driver.connectUsbClients(devicesArray[0].serial, 6000);
  console.log(clients);

  const client = clients[0];
  console.log(client.info.query.raw_info);

  // large message test, UsbClient::Read should not crash for large param size : 8388608
  const largeMessageSize = 8388608;
  const largeMessage = 'a'.repeat(largeMessageSize);
  const result1 = await client.sendCustomizedMessage("App.GetCloseCoverageUploadSwitch", { message: largeMessage }, -1, "App");
  console.log(result1);

  process.exit(0);
}

main();