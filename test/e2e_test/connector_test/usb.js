const DebugRouterConnector = require("@lynx-js/debug-router-connector").DebugRouterConnector;

const front_end = require('./front_end.js');  
const util = require('./util.js');  

const DEFAULT_ROOM_ID = '33ad9856-6085-42e7-80ea-b0c4b5c99b40';

async function main() {
  console.log('start main:');
  const driver = new DebugRouterConnector({
    manualConnect: false,
    enableWebSocket: true,
    enableAndroid: true,
    enableIOS: false,
    enableDesktop: false,
    websocketOption: {
      port: -1,
      roomId: DEFAULT_ROOM_ID
    }
  });
  const websocketServer = await util.startServer(driver);
  if (websocketServer === null || websocketServer.wssPath === null) {
    console.log("TEST FAILED:" + 'start websocketServer failed!');
    process.exit(-1);
  }
  front_end.front_validate(websocketServer.wssPath, DEFAULT_ROOM_ID);
  driver.connectDevices();
  const startActivity = 'adb shell am start -n com.lynx.debugrouter.testapp/com.lynx.debugrouter.testapp.MainActivity --es connection_type usb'
  util.exec(startActivity, 10000).then((data) => {
    console.log("startActivity:" + data);
  }).catch((reason) => {
    console.log("startActivity FAILED:" + reason);
    process.exit(-1);
  })
}

main();
