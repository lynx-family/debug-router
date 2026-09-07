// Copyright 2024 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

import { Client } from "../connector/Client";
import {
  CDPEventHandler,
  ClientDescription,
  EventHandler,
  RequireMessageType,
  ResponseMessageType,
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

  on(event: string, callback: EventHandler): void {
    // This functionality has moved to the corresponding multiplexer mirror.
  }

  onAllEvents(callback: CDPEventHandler): void {
    // This functionality has moved to the corresponding multiplexer mirror.
  }

  off(event: string, callback: EventHandler): void {
    // This functionality has moved to the corresponding multiplexer mirror.
  }

  once(event: string, callback: EventHandler): void {
    // This functionality has moved to the corresponding multiplexer mirror.
  }

  protected rawSend(message: RequireMessageType): Promise<ResponseMessageType> {
    // This functionality has moved to the corresponding multiplexer mirror.
    return Promise.resolve({} as ResponseMessageType);
  }

  sendCustomizedMessage(
    method: string,
    params: Object = "",
    sessionId: number = -1,
    type: string = "CDP",
  ): Promise<string> {
    // This functionality has moved to the corresponding multiplexer mirror.
    return Promise.resolve("");
  }

  sendRawMessage(message: RequireMessageType): Promise<ResponseMessageType> {
    // This functionality has moved to the corresponding multiplexer mirror.
    return Promise.resolve({} as ResponseMessageType);
  }

  // just send message
  sendMessage(message: any) {
    this.connection.send(message);
  }

  sendClientMessage(method: string, params: Object = {}): Promise<string> {
    // This functionality has moved to the corresponding multiplexer mirror.
    return Promise.resolve("");
  }
}
