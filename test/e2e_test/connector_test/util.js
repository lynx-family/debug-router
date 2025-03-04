const child_process = require('child_process');

async function startServer(driver) {
    return new Promise(async (resolve) => {
      await driver.startWSServer();
      resolve(driver.wss);
    });
}

async function exec(cmd, timeout) {
    return new Promise((resolve, reject) => {
        child_process.exec(cmd, (error, stdout, stderr) => {
            if (error == null) {
                resolve(stdout)
            } else {
                reject(stderr)
            }
        })
        setTimeout(() => {
            reject("timeout:" + timeout + " exec:" + cmd);
        }, timeout);
    });
}
module.exports = {startServer,exec}; 