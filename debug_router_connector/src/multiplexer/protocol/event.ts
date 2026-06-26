// Copyright 2024 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

import type { ControlMessageMeta } from "./control";
import type {
  ClientSnapshot,
  DeviceSnapshot,
  Snapshot,
  WebSocketClientSnapshot,
} from "./snapshot";

export type ControlEventEnvelope<Event extends string, Data> = {
  kind: "event";
  event: Event;
  data: Data;
  meta?: ControlMessageMeta;
};

export type ControlEvent =
  | ControlEventEnvelope<"snapshot", Snapshot>
  | ControlEventEnvelope<
      "legacy-ownership-changed",
      {
        status: "attached" | "unattached";
        ownerPid: number;
        previousOwnerPid?: number;
        reason:
          | "daemon-started"
          | "legacy-preempted"
          | "reacquire-requested"
          | "stale-owner"
          | "invalid-owner";
      }
    >
  | ControlEventEnvelope<"device-connected", DeviceSnapshot>
  | ControlEventEnvelope<
      "device-disconnected",
      {
        serial: string;
      }
    >
  | ControlEventEnvelope<"client-connected", ClientSnapshot>
  | ControlEventEnvelope<
      "client-disconnected",
      {
        id: number;
      }
    >
  | ControlEventEnvelope<
      "usb-client-message",
      {
        id: number;
        message: string;
      }
    >
  | ControlEventEnvelope<
      "ws-client-message",
      {
        id: number;
        message: string;
      }
    >
  | ControlEventEnvelope<
      "ws-web-message",
      {
        id: number;
        message: string;
      }
    >
  | ControlEventEnvelope<
      "websocket-app-client-connected",
      WebSocketClientSnapshot
    >
  | ControlEventEnvelope<
      "websocket-app-client-disconnected",
      {
        id: number;
      }
    >
  | ControlEventEnvelope<
      "websocket-web-client-connected",
      WebSocketClientSnapshot
    >
  | ControlEventEnvelope<
      "websocket-web-client-disconnected",
      {
        id: number;
      }
    >;
