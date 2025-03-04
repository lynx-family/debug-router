const WebSocket = require('ws')

async function message_listen(ws, message, timeout) {
    return new Promise((resolve, reject) => {
      ws.on('message', (data) => {
        if (data.indexOf(message) != -1) {
          resolve("true");
        }
      });
      setTimeout(() => {
        reject("timeout:" + timeout + " receive:" + message);
      }, timeout);
    });
  }

function front_validate(wssPath, DEFAULT_ROOM_ID) {
    let client_id = -1;
    const ws = new WebSocket(wssPath);
    console.log('start listen:');
    ws.on('error', (err) => {
        console.log("TEST FAILED:" + JSON.stringify(err));
        process.exit(-1);
    });

    ws.on('open', function open() {
        console.log('OnOpen');
    });

    ws.on('message', (data) => {
        console.log('received: %s', data);
        const msg = JSON.parse(data);
        if (msg.event === 'Initialize') {
            // {"event":"Initialize","data":2}
            client_id = msg.data;
            const registerMsg = `{"event":"Register","data":{"id":${msg.data},"type":"Driver"}}`
            ws.send(registerMsg)
        } else if (msg.event === 'RoomJoined') {
            // {"event":"RoomJoined","data":{"room":"33ad9856-6085-42e7-80ea-b0c4b5c99b40","id":2}}
            if (msg.data.room != DEFAULT_ROOM_ID) {
                console.log("TEST FAILED:" + "RoomJoined msg is illegal:" + msg);
                process.exit(-1);
            }
        }
        if (msg.event === 'ClientList' && msg.data.length == 1 && msg.data[0].info.App === "com.lynx.debugrouter.testapp") {
            console.log("start send hello:")
            ws.send(`{"event":"Customized","data":{"type":"Hello1","data":{"client_id":${msg.data[0].id}},"sender":${client_id}},"to":${msg.data[0].id}}`);
            message_listen(ws, "Hello2", 5000).then(data => {
                console.log("TEST SUCCESS");
                process.exit(0);
            }).catch(reason => {
                console.log("TEST FAILED:" + reason);
                process.exit(-1);
            })
        }

    });
}
module.exports = {front_validate}; 