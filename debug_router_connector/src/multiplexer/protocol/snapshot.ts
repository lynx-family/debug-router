// Copyright 2024 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

import type { ClientDescription, DeviceDescription } from "../../utils/type";

// protocolVersion is used for version arbitration when connecting to the Multiplexer daemon.
// minSupportedProtocolVersion is used to check if the Multiplexer daemon supports the protocol version.
// daemonVersion and clientVersion is only injected for testing or debugging purposes and is not used in version arbitration.

export type Snapshot = {
  protocolVersion: number;
  generatedAt: number;
  devices: DeviceSnapshot[];
  clients: ClientSnapshot[];
  websocketAppClients?: WebSocketClientSnapshot[];
  websocketWebClients?: WebSocketClientSnapshot[];
  daemonVersion?: string;
  capabilities?: string[];
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
