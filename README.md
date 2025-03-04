# DebugRouter 🚀
DebugRouter serves as the infrastructure for Lynx DevTool, providing a stable connection between apps and the Lynx DevTool Desktop App. The Lynx DevTool Desktop App uses it to send, receive and transmit debugging protocols to Lynx. It also supports the registration of custom protocols. You can implement a cross-platform testing framework based on DebugRouter (not limited to Lynx). DebugRouter offers multiple connection methods, including USB, WebSocket, local device sockets and remote device sockets.

Two products are offered: **debug_router** and **debug_router_connector**.

- **debug_router**: A client SDK that supports four system types: Android, iOS, Windows, and POSIX-compliant operating systems.
- **debug_router_connector**: An NPM package implemented in TypeScript, providing the capability to connect with the **debug_router** and interfaces for sending messages to and receiving messages from it.

## 📌 Table of Contents

- [DebugRouter 🚀](#debugrouter-)
  - [📌 Table of Contents](#-table-of-contents)
  - [✨ Features](#-features)
  - [🚀 Getting Started](#-getting-started)
  - [🤝 Contributing](#-contributing)
  - [📄 License](#-license)
  - [🎉 Acknowledgments](#-acknowledgments)

## ✨ Features

- 🌟 Supports connection to all major devices.
DebugRouter supports four types of devices: Android, iOS, Windows, and POSIX-compliant systems.
- 🌟 A unified TypeScript interface is used for connecting devices and processing messages.
The benefit of a unified TypeScript interface is that a single set of test code can be used across various platforms, effectively abstracting away platform-specific differences. Consequently, **debug_router_connector** enables the swift creation of unified test cases that operate on multiple platforms, streamlining cross-platform business testing.
- 🌟 The **debug_router** easily supports protocol extensions, which can be invoked through the **debug_router_connector**. For more detailed usage instructions, please refer to the [README file](debug_router_connector/README.md) located in the debug_router_connector directory.

##  🚀 Getting Started
Let's introduce how to quickly get started with DebugRouter. For detailed integration and usage documentation, please refer to the README files in the debug_router and debug_router_connector directories.

### Install debug_router_example to your phone

#### Android
``` bash
cd test/e2e_test/AndroidExample
./gradlew app:assembleDebug
```
then you can find the apk in ```app/build/outputs/apk/debug/app-debug.apk```.  
  
#### iOS

``` bash
cd test/e2e_test/iOSExample
bundle install && bundle exec pod install
```
- Open DebugRouter.xcworkspace
- Connect your mobile phone to your Mac using a USB cable.
- Use Xcode to build and install DebugRouterExample to your phone.


### Run debug_router_connector
Compile debug_router_connector
``` bash
cd debug_router_connector && npm install && npm run build
```
Run debug_router_connector demo
``` bash
cd test/e2e_test/connector_test && npm install && node index.js
```
### Check Result
If the execution result of `node index.js` includes your device name and debug_router_example information, it means the execution was successful.

## 🤝 How to Contribute
### Code of Conduct
We are devoted to ensuring a positive, inclusive, and safe environment for all contributors. Please find our [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) for detailed information.

### Contributing Guide
We welcome you to join and become a member of Lynx Authors. It's people like you that make this project great.

Please refer to our [contributing guide](CONTRIBUTING.md) for details.

## 🛡️ Security
See [SECURITY.md](SECURITY.md) for more information.

## 📄 License 
DebugRouter is Apache licensed, as found in the [LICENSE](LICENSE) file.

## 🎉 Acknowledgments 
For a more comprehensive list of acknowledgments, please see [Acknowledgments](ACKNOWLEDGMENTS.md).
