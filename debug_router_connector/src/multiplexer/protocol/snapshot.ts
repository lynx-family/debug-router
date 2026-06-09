// Copyright 2024 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

import type { ClientDescription, DeviceDescription } from "../../utils/type";

export type Snapshot = {
  protocolVersion: number;
  generatedAt: number;
  devices: DeviceSnapshot[];
  clients: ClientSnapshot[];
  daemonVersion?: string;
  capabilities?: string[];
};

export type DeviceSnapshot = DeviceDescription & {
  ports?: number[];
  host?: string;
};

export type ClientSnapshot = ClientDescription;

export type WebSocketClientSnapshot = { // Will be used in the future
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
