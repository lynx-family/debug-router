// Copyright 2026 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

import type { ClientDescription, DeviceDescription } from "../../utils/type";
import type { MultiplexerDebugInfo } from "./debuginfo";

export type Snapshot = {
  protocolVersion: number;
  generatedAt: number;
  devices: DeviceSnapshot[];
  clients: ClientSnapshot[];
  websocketAppClients?: WebSocketClientSnapshot[];
  websocketWebClients?: WebSocketClientSnapshot[];
  debugInfo?: MultiplexerDebugInfo;
};

export type DeviceSnapshot = DeviceDescription & {
  ports?: number[];
  host?: string;
};

export type ClientSnapshot = ClientDescription;

export type WebSocketClientSnapshot = {
  id: number;
  app: string;
  debugRouterVersion: string;
  deviceModel: string;
  network: "WiFi";
  osVersion: string;
  sdkVersion: string;
  type: string;
  raw_info: unknown;
};
