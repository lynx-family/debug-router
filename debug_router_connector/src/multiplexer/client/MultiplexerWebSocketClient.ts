// Copyright 2026 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

import { Client } from "../../connector/Client";
import {
  CustomizedEventType,
  RequireMessageType,
  SocketEvent,
  isCustomizedEventType,
} from "../../utils/type";
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
      .call("sendMessageWithoutReply", {
        target: this.type() === "Driver" ? "web" : "app",
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
    const message: RequireMessageType = {
      event: SocketEvent.Customized,
      data: {
        type,
        data: {
          client_id: -1,
          session_id: sessionId,
          message: {
            id: Client.messageIdCounter++,
            method,
            params,
          },
        },
        sender: 0,
      },
    };

    return this.daemonClient
      .call("sendMessageWithReply", {
        clientId: this.clientId(),
        message,
      })
      .then((response) => {
        if (
          !isCustomizedEventType(response, CustomizedEventType.CDP) &&
          !isCustomizedEventType(response, CustomizedEventType.App)
        ) {
          throw new Error("Invalid Customized response type");
        }

        const responseMessage = (response as any)?.data?.data?.message;
        if (typeof responseMessage === "string") {
          return responseMessage;
        }
        if (responseMessage !== undefined) {
          const serialized = JSON.stringify(responseMessage);
          if (serialized !== undefined) {
            return serialized;
          }
        }

        throw new Error("Invalid Customized response message");
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
