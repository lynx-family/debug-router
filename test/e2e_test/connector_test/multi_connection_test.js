const DebugRouterConnector = require("@lynx-js/debug-router-connector").DebugRouterConnector;

const util = require('./util.js');

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

let successCount = 0;

async function TryConnect(driver) {
  const devicesArray = await driver.connectDevices(6000);
  console.log(devicesArray[0]);
  if (devicesArray.length === 0) {
    console.error('no devices connected');
    return;
  }
  const clients = await driver.connectUsbClients(devicesArray[0].serial, 6000);
  if (clients && clients.length > 0) {
    console.log(clients[0].info.query.raw_info);
    successCount++;
  } else {
    console.error('no clients connected');
  }
}

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

  try {
    const Connect0 = TryConnect(driver);
    await sleep(3000);
    const Connect1 = TryConnect(driver);
    await sleep(3000);
    const Connect2 = TryConnect(driver);
    await sleep(3000);
    const Connect3 = TryConnect(driver);
    await sleep(3000);
    const Connect4 = TryConnect(driver);
    await sleep(3000);
    const Connect5 = TryConnect(driver);
    await sleep(3000);
    const Connect6 = TryConnect(driver);
    await sleep(3000);
    const Connect7 = TryConnect(driver);
    await sleep(3000);
    const Connect8 = TryConnect(driver);
    await sleep(3000);
    const Connect9 = TryConnect(driver);
    await sleep(3000);

    await Promise.all([Connect0, Connect1, Connect2, Connect3, Connect4, Connect5, Connect6, Connect7, Connect8, Connect9]);
    console.log('successCount: ', successCount);
  } catch (error) {
    console.error('Call tryConnect error: ', error);
  }
  process.exit(0);
}

main();