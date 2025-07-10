<div>

## Introduction
DebugRouter serves as the infrastructure for [Lynx DevTool](https://github.com/lynx-family/lynx-devtool), providing a stable connection between apps and the Lynx DevTool Desktop App. The Lynx DevTool Desktop App uses it to send, receive and transmit debugging protocols to [Lynx](https://github.com/lynx-family/lynx). It also supports the registration of custom protocols. You can implement a cross-platform testing framework based on DebugRouter (not limited to Lynx). DebugRouter offers multiple connection methods, including USB, WebSocket, local device sockets and remote device sockets.


## Installation

```bash
ohpm install @lynx/debug_router
```

## How to use

You can add dependency in oh-package.json5 like this:

```json5
{
  "dependencies": {
    "@lynx/debug_router": "0.0.1",
  }
}
```
</div>
