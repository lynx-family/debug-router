// Copyright 2026 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

import type { MultiplexerDebugInfo } from "./debuginfo";
import type { Snapshot } from "./snapshot";

export type ControlEventEnvelope<Event extends string, Data> = {
  kind: "event";
  event: Event;
  data: Data;
  debugInfo?: MultiplexerDebugInfo;
};

export type ControlEvent =
  /**
   * Carries the daemon's authoritative device and client state.
   * The daemon sends an initial snapshot when a control connection is created
   * and sends a new full snapshot after lifecycle changes. The Connector
   * compares consecutive snapshots to produce its public connected and
   * disconnected events.
   */
  | ControlEventEnvelope<"snapshot", Snapshot>
  /**
   * Reports whether the daemon currently owns the legacy single-process
   * physical-connection resource. Consumers can use this event to expose
   * multi-open availability without inspecting the owner file themselves.
   */
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
  /**
   * Carries a raw message received from a USB Runtime, WiFi Runtime, or
   * WebSocket Driver. `source` identifies the transport/client domain and `id`
   * identifies the source client whose public message event should be emitted.
   */
  | ControlEventEnvelope<
      "client-message",
      {
        source: "usb-runtime" | "websocket-runtime" | "websocket-driver";
        id: number;
        message: string;
      }
    >;
