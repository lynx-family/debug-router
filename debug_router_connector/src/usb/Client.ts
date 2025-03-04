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

export class UsbClient implements Client {
  private messageIdCounter = 1;

  constructor(
    readonly info: ClientDescription,
    readonly connection: Connection,
  ) {}

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

  off(event: string, callback: EventHandler) {
    this.connection.off(event, callback);
  }

  once(event: string, callback: EventHandler) {
    this.connection.once(event, callback);
  }

  protected rawSend(message: RequireMessageType): Promise<ResponseMessageType> {
    return new Promise(async (resolve, reject) => {
      const response = await this.connection.sendExpectResponse(message);
      resolve(response);
    });
  }

  // send sendCustomizedMessage and wait result
  sendCustomizedMessage(
    method: string,
    params: Object = "",
    sessionId: number = -1,
    type: string = "CDP",
  ): Promise<string> {
    const id = this.messageIdCounter++;
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
    return new Promise(async (resolve, reject) => {
      const response: ResponseMessageType = (await this.rawSend(
        msg,
      )) as CustomizeResponseType;
      if (
        isCustomizedEventType(response, CustomizedEventType.CDP) ||
        isCustomizedEventType(response, CustomizedEventType.App)
      ) {
        // @ts-ignore
        resolve(response.data.data.message);
      }
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
