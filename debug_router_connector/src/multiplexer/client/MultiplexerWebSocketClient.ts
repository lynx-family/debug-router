// Copyright 2024 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

import { WebSocketClient } from "../../websocket/WebSocketConnection";
import type { WebSocketClientSnapshot } from "../protocol";
import { MultiplexerDaemonClient } from "./MultiplexerDaemonClient";

export type MultiplexerWebSocketClientOption = {
  snapshot: WebSocketClientSnapshot;
  daemonClient: MultiplexerDaemonClient;
  handleListClients?: () => void;
};

export class MultiplexerWebSocketClient extends WebSocketClient {
  private readonly daemonClient: MultiplexerDaemonClient;
  private readonly handleListClientsCallback?: () => void;

  constructor(option: MultiplexerWebSocketClientOption) {
    super(
      {} as any,
      cloneSnapshot(option.snapshot),
      createInertWebSocket() as any,
    );
    this.daemonClient = option.daemonClient;
    this.handleListClientsCallback = option.handleListClients;
  }

  static fromSnapshot(
    snapshot: WebSocketClientSnapshot,
    daemonClient: MultiplexerDaemonClient,
    handleListClients?: () => void,
  ): MultiplexerWebSocketClient {
    return new MultiplexerWebSocketClient({
      snapshot,
      daemonClient,
      handleListClients,
    });
  }

  updateFromSnapshot(snapshot: WebSocketClientSnapshot): void {
    if (snapshot.id !== this.clientId()) {
      throw new Error(
        `Cannot update multiplexer WebSocket client ${this.clientId()} with snapshot ${
          snapshot.id
        }`,
      );
    }
    const next = cloneSnapshot(snapshot);
    Object.assign(this.info, next);
  }

  clientId(): number {
    return this.info.id;
  }

  type(): string {
    return this.info.type;
  }

  close(): void {
    void this.daemonClient
      .call("closeClient", { clientId: this.clientId() })
      .catch(() => {});
  }

  sendMessage(message: string): void {
    void this.daemonClient
      .call("sendMessage", {
        clientId: this.clientId(),
        message,
      })
      .catch(() => {});
  }

  sendCustomizedMessage(
    method: string,
    params: Object | string = "",
    sessionId: number = -1,
    type: string = "CDP",
  ): Promise<string> {
    return this.daemonClient.call("sendCustomizedMessage", {
      clientId: this.clientId(),
      method,
      params,
      sessionId,
      type,
    });
  }

  handleListClients(): void {
    if (this.type() !== "Driver") {
      return;
    }
    this.handleListClientsCallback?.();
  }
}

function cloneSnapshot(
  snapshot: WebSocketClientSnapshot,
): WebSocketClientSnapshot {
  return JSON.parse(JSON.stringify(snapshot));
}

function createInertWebSocket(): { on(): void } {
  return {
    on(): void {},
  };
}
