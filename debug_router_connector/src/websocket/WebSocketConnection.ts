// Copyright 2024 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

import { WebSocket } from "ws";
import { WebSocketController } from "./WebSocketServer";
import { defaultLogger } from "../utils/logger";
import { Client } from "../connector/Client";

export type WebSocketClientInfo = {
  id: number;
  app: string;
  debugRouterVersion: string;
  deviceModel: string;
  network: "WiFi";
  osVersion: string;
  sdkVersion: string;
  type: string;
  raw_info: any;
};

export class WebSocketClient implements Client {
  constructor(
    private readonly server: WebSocketController,
    readonly info: WebSocketClientInfo,
    private readonly socket: WebSocket,
  ) {
    socket.on("message", this.handleMessage.bind(this));
    socket.on("close", this.handleClose.bind(this));
  }

  clientId(): number {
    return this.info.id;
  }

  type() {
    return this.info.type;
  }

  sendMessage(message: string) {
    this.socket.send(message);
  }

  close() {
    this.socket.close();
  }

  handleListClients() {
    if (this.info.type !== "Driver") {
      return;
    }
    const wsClients = this.server.getAllWebsocketAppClients();
    const data = new Array();
    wsClients.forEach((client) => {
      if (client.clientId() === this.clientId()) return;
      data.push({
        id: client.clientId(),
        type: client.info.type,
        info: {
          ...client.info.raw_info,
          network: "WiFi",
        },
      });
    });

    const usbClients = this.server.getAllUsbClients();
    usbClients.forEach((client) => {
      if (client.clientId() === this.clientId()) return;
      data.push({
        id: client.clientId(),
        type: "runtime",
        info: {
          ...client.info.query.raw_info,
          deviceName: client.info.query.device,
          osType: client.info.query.os,
          deviceModel: client.info.query.device_model,
          network: "USB",
        },
      });
    });
    const response = {
      event: "ClientList",
      data: data,
    };
    const jsonResponse = JSON.stringify(response);
    defaultLogger.debug("Driver: ClientList:" + jsonResponse);
    this.socket.send(jsonResponse);
  }

  private handleClose() {
    this.server.handleDisconnect(this.clientId());
  }

  private isBufferClass(data: any) {
    if (Array.isArray(data) && data.every((item) => item instanceof Buffer)) {
      defaultLogger.debug("handleMessage received data with type 'Buffer[]'");
      return true;
    } else if (data instanceof Buffer) {
      defaultLogger.debug("handleMessage received data with type 'Buffer'");
      return true;
    } else if (data instanceof ArrayBuffer) {
      defaultLogger.debug(
        "handleMessage received data with type 'ArrayBuffer'",
      );
      return true;
    }
    return false;
  }

  private handleMessage(data: any): void {
    let dataString = "";
    if (this.isBufferClass(data)) {
      dataString = data.toString();
    } else if (typeof data === "string") {
      dataString = data;
      defaultLogger.debug("handleMessage received data with type 'string'");
    }
    const message = JSON.parse(dataString);
    if (this.type() === "Driver") {
      this.server.emitEvent("ws-web-message", this.clientId(), dataString);
    } else {
      this.server.emitEvent("ws-client-message", this.clientId(), dataString);
    }
    if (message.event === "ListClients") {
      this.handleListClients();
    } else if (message.event === "Ping") {
      this.handlePing();
    } else if (message.event === "Customized") {
      this.handleCustomizedMessage(message, dataString);
    }
  }

  private handleCustomizedMessage(data: any, message: string) {
    if (this.type() === "Driver") {
      // message from web, only send to app
      const id = data.data?.data?.client_id ?? -1;
      if (id == -1) {
        return;
      }
      this.server.sendMessageToApp(id, message);
    } else {
      // message from app, only send to web
      const id = data.data?.sender ?? -1;
      if (id == -1) {
        return;
      }
      this.server.sendMessageToWeb(message);
    }
  }

  private handlePing() {
    if (this.info.type !== "Driver") {
      return;
    }
    const response = {
      event: "Pong",
    };
    this.socket.send(JSON.stringify(response));
  }
}
