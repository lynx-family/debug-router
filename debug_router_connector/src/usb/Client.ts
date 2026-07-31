// Copyright 2024 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

import { Client } from "../connector/Client";
import {
  ClientDescription,
  CustomizedEventType,
  CustomizeResponseType,
  CDPEventHandler,
  EventHandler,
  isCustomizedEventType,
  RequireMessageType,
  ResponseMessageType,
  SocketEvent,
} from "../utils/type";
import { Connection } from "./Connection";

export class UsbClient extends Client {
  constructor(
    readonly info: ClientDescription,
    readonly connection: Connection,
  ) {
    super();
  }

  clientId(): number {
    return this.info.id;
  }

  deviceId() {
    return this.info.query.device_id;
  }

  close() {
    this.connection.close();
  }

  on(event: string, callback: EventHandler) {
    this.connection.on(event, callback);
  }

  onAllEvents(callback: CDPEventHandler) {
    this.connection.onAllEvents(callback);
  }

  offAllEvents(callback: CDPEventHandler) {
    this.connection.offAllEvents(callback);
  }

  off(event: string, callback: EventHandler) {
    this.connection.off(event, callback);
  }

  once(event: string, callback: EventHandler) {
    this.connection.once(event, callback);
  }

  protected rawSend(
    message: RequireMessageType,
    timeoutMs?: number,
  ): Promise<ResponseMessageType> {
    return this.connection.sendExpectResponse(message, timeoutMs);
  }

  // send sendCustomizedMessage and wait result
  sendCustomizedMessage(
    method: string,
    params: Object = "",
    sessionId: number = -1,
    type: string = "CDP",
    timeoutMs?: number,
  ): Promise<string> {
    const id = Client.messageIdCounter++;
    const msg: RequireMessageType = {
      event: SocketEvent.Customized,
      data: {
        type: type,
        data: {
          client_id: -1,
          session_id: sessionId,
          message: {
            id: id,
            method: method,
            params: params,
          },
        },
        sender: 0,
      },
    };
    return this.rawSend(msg, timeoutMs).then((response) => {
      if (
        isCustomizedEventType(response, CustomizedEventType.CDP) ||
        isCustomizedEventType(response, CustomizedEventType.App)
      ) {
        return (response as any).data.data.message;
      }
      throw new Error(`Unexpected Customized response type`);
    });
  }

  // send message and wait result
  sendRawMessage(message: RequireMessageType): Promise<ResponseMessageType> {
    return this.rawSend(message);
  }

  // just send message
  sendMessage(message: any) {
    this.connection.send(message);
  }

  // send ClientMessageHandler message and wait result
  sendClientMessage(method: string, params: Object = {}): Promise<string> {
    return this.sendCustomizedMessage(method, params, -1, "App");
  }
}
