const DebugRouterConnector = require("@lynx-js/debug-router-connector").DebugRouterConnector;

const util = require('./util.js');

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}


async function TryConnect(driver, serial, num) {
  console.log('TryConnect start: ', num);
  // just connect through usb, no msg transceiver
  // connectUsbClients trige new usb client, but did not send initialize msg
  const clients = await driver.connectUsbClients(serial, 1000);
  if (clients && clients.length > 0) {
    if (num < 10) {
      return;
    }
    console.log('TryConnect check the last connect start: ', num);
    const message = 'a'.repeat(20);
    const result = await clients[0].sendCustomizedMessage("App.GetCloseCoverageUploadSwitch", { message: message }, -1, "App");
    console.log(result);
    if (!result) {
      console.error('sendCustomizedMessage failed');
      process.exit(-1);
    } else {
      console.log('sendCustomizedMessage success');
    }
  } else {
    console.error('no clients connected');
  }
  console.log('TryConnect end:  ', num);
}

async function main() {
  const startActivity = 'adb shell am start -n com.lynx.debugrouter.testapp/com.lynx.debugrouter.testapp.MainActivity'
  util.exec(startActivity, 10000).then((data) => {
    console.log("startActivity:" + data);
  }).catch((reason) => {
    console.log("startActivity FAILED:" + reason);
    process.exit(-1);
  });

  const driver = new DebugRouterConnector({
    manualConnect: true,
    enableWebSocket: false,
    enableAndroid: true,
    enableIOS: true,
    enableDesktop: false,
    websocketOption: {}
  });

  try {
    const devicesArray = await driver.connectDevices(2000);
    if (devicesArray.length === 0) {
      console.error('no devices connected');
      return;
    }
    var serial = devicesArray[0].serial;
    const Connect0 = TryConnect(driver, serial, 1);
    const Connect1 = TryConnect(driver, serial, 2);
    const Connect2 = TryConnect(driver, serial, 3);
    const Connect3 = TryConnect(driver, serial, 4);
    const Connect4 = TryConnect(driver, serial, 5);
    const Connect5 = TryConnect(driver, serial, 6);
    const Connect6 = TryConnect(driver, serial, 7);
    const Connect7 = TryConnect(driver, serial, 8);
    const Connect8 = TryConnect(driver, serial, 9);
    const Connect9 = TryConnect(driver, serial, 10);
    await Promise.all([Connect0, Connect1, Connect2, Connect3, Connect4, Connect5, Connect6, Connect7, Connect8, Connect9]);
    console.log('TryConnect test end.');
  } catch (error) {
    console.error('Call tryConnect error: ', error);
  }
  process.exit(0);
}

main();