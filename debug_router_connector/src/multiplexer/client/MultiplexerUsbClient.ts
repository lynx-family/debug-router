// Copyright 2026 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

import { EventEmitter } from "events";
import { Client } from "../../connector/Client";
import { defaultLogger } from "../../utils/logger";
import {
  CDPEventHandler,
  ClientDescription,
  CustomizedEventType,
  EventHandler,
  RequireMessageType,
  ResponseMessageType,
  SocketEvent,
  isCustomizedEventType,
  isTypedSocketMessage,
} from "../../utils/type";
import type { ClientSnapshot } from "../protocol";
import { MultiplexerDaemonClient } from "./MultiplexerDaemonClient";

export type MultiplexerUsbClientOption = {
  snapshot: ClientSnapshot;
  daemonClient: MultiplexerDaemonClient;
};

export class MultiplexerUsbClient extends Client {
  private readonly events = new EventEmitter();
  private snapshot: ClientSnapshot;
  private readonly daemonClient: MultiplexerDaemonClient;

  constructor(option: MultiplexerUsbClientOption) {
    super();
    this.snapshot = cloneClientSnapshot(option.snapshot);
    this.daemonClient = option.daemonClient;
  }

  static fromSnapshot(
    snapshot: ClientSnapshot,
    daemonClient: MultiplexerDaemonClient,
  ): MultiplexerUsbClient {
    return new MultiplexerUsbClient({
      snapshot,
      daemonClient,
    });
  }

  get info(): ClientDescription {
    return cloneClientSnapshot(this.snapshot);
  }

  updateFromSnapshot(snapshot: ClientSnapshot): void {
    if (snapshot.id !== this.clientId()) {
      throw new Error(
        `Cannot update multiplexer USB client ${this.clientId()} with snapshot ${
          snapshot.id
        }`,
      );
    }

    this.snapshot = cloneClientSnapshot(snapshot);
  }

  clientId(): number {
    return this.snapshot.id;
  }

  deviceId(): string {
    return this.snapshot.query.device_id;
  }

  close(): void {
    void this.daemonClient
      .call("closeClient", {
        clientId: this.clientId(),
      })
      .catch((error: Error) => {
        defaultLogger.warn(
          `Failed to close multiplexer USB client: ${error.message}`,
        );
      });
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

    return this.sendRawMessage(message).then((response) => {
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

  sendRawMessage(message: RequireMessageType): Promise<ResponseMessageType> {
    return this.daemonClient.call("sendMessageWithReply", {
      clientId: this.clientId(),
      message,
    });
  }

  sendMessage(message: unknown): void {
    void this.daemonClient
      .call("sendMessageWithoutReply", {
        target: "app",
        clientId: this.clientId(),
        message,
      })
      .catch((error: Error) => {
        defaultLogger.warn(
          `Failed to send multiplexer USB client message: ${error.message}`,
        );
      });
  }

  sendClientMessage(method: string, params: Object = {}): Promise<string> {
    return this.sendCustomizedMessage(method, params, -1, "App");
  }

  on(event: string, callback: EventHandler): void {
    this.events.on(event, callback);
  }

  onAllEvents(callback: CDPEventHandler): void {
    this.events.on("all-cdp-message", callback);
  }

  off(event: string, callback: EventHandler): void {
    this.events.off(event, callback);
  }

  once(event: string, callback: EventHandler): void {
    this.events.once(event, callback);
  }

  handleMessage(message: string): void {
    const payload = parseClientMessage(message);
    if (!payload) {
      return;
    }

    if (!isTypedSocketMessage(payload, SocketEvent.Customized)) {
      return;
    }

    this.handleCustomizedMessage(payload);
  }

  private handleCustomizedMessage(payload: any): void {
    const data = payload.data;
    if (isCustomizedEventType(payload, CustomizedEventType.SessionList)) {
      this.events.emit("SessionList", data.data);
      return;
    }

    if (
      !isCustomizedEventType(payload, CustomizedEventType.CDP) &&
      !isCustomizedEventType(payload, CustomizedEventType.App)
    ) {
      return;
    }

    const message = data?.data?.message;
    if (typeof message !== "string") {
      return;
    }

    const cdpMessage = parseClientMessage(message);
    if (!cdpMessage || cdpMessage.id || typeof cdpMessage.method !== "string") {
      return;
    }

    this.handleClientEvent(
      cdpMessage.method,
      cdpMessage.params,
      data.data?.session_id,
    );
  }

  private handleClientEvent(
    event: string,
    params: unknown,
    sessionId: number | undefined,
  ): void {
    const session = {
      session_id: sessionId !== undefined ? sessionId : -1,
    };
    this.events.emit(event, params, session);
    this.events.emit("all-cdp-message", event, params, session);
  }
}

function cloneClientSnapshot(snapshot: ClientSnapshot): ClientSnapshot {
  return JSON.parse(JSON.stringify(snapshot));
}

function parseClientMessage(message: string): any | null {
  try {
    return JSON.parse(message);
  } catch (_error) {
    return null;
  }
}
