// Copyright 2024 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

export { DebugRouterConnector } from "./connector";
export type { DebugRouterConnectorOption, devOption } from "./connector";
export { MultiplexerDevice, MultiplexerUsbClient } from "./multiplexer";
export type {
  ClientSnapshot,
  ControlEvent,
  ControlEventEnvelope,
  DeviceSnapshot,
  MultiplexerDeviceOption,
  MultiplexerUsbClientOption,
  Snapshot,
  WebSocketClientSnapshot,
} from "./multiplexer";
// enum
export { SocketEvent } from "./utils/type";
export { MultiOpenStatus } from "./connector/MultiOpenCallBack";
export { WatchStatus } from "./device/WatchStatus";

//interface
export { MultiOpenCallback } from "./connector/MultiOpenCallBack";
export { DriverReportService } from "./report/interface/DriverReportService";
export { Client } from "./connector/Client";
export {
  ConnectionTraceNode,
  ConnectionTraceOptions,
} from "./trace/ConnectionTraceRecorder";

// class
export { UsbClient } from "./usb/Client";
export { WebSocketClient } from "./websocket/WebSocketConnection";
export { BaseDevice } from "./device/BaseDevice";
export { DeviceManager } from "./device/DeviceManager";

// methods
export { defaultLogger } from "./utils/logger";
export { getDriverReportService } from "./report/interface/DriverReportService";
