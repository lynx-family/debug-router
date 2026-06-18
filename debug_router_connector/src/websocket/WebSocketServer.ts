// Copyright 2024 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

import { WebSocket, WebSocketServer } from "ws";
import { WebSocketClientInfo, WebSocketClient } from "./WebSocketConnection";
import { UsbClient } from "../usb/Client";
import { BaseDevice } from "../device/BaseDevice";
import { getDriverReportService } from "../report/interface/DriverReportService";
import { DebugerRouterDriverEvents } from "../utils/type";

export type WebSocketControllerHost = {
  createClientId(): number;
  getAllUsbClients(): UsbClient[];
  getDevices(): Promise<BaseDevice[]>;
  emit?<Event extends keyof DebugerRouterDriverEvents>(
    event: Event,
    payload: DebugerRouterDriverEvents[Event],
  ): void;
  handleWsMessage?(id: number, message: string): void;
  handleWebSocketMessage?(
    webClientId: number,
    targetClientId: number,
    message: string,
  ): void;
  handleWebSocketAppMessage?(appClientId: number, message: string): void;
  handleWebSocketClientConnected?(clientId: number, type: string): void;
  handleWebSocketClientDisconnected?(clientId: number, type: string): void;
};

export class WebSocketController {
  private controllerHost: WebSocketControllerHost;
  private port: number;
  private host: string;
  private roomId: string;
  private wssPath: string;
  private server: WebSocketServer;
  // websocketAppClients
  private websocketAppClients: Map<number, WebSocketClient> = new Map();
  // web clients
  private webClients: Map<number, WebSocketClient> = new Map();
  private closed = false;

  constructor(
    host: WebSocketControllerHost,
    option: {
      port: number;
      host: string;
      roomId?: string;
      callback?: () => void;
    },
  ) {
    this.controllerHost = host;
    this.port = option.port;
    this.host = option.host;
    this.wssPath = `ws://${this.host}/mdevices/page/android`;
    this.roomId = option.roomId ?? "";
    const wsService = new WebSocketServer({
      port: this.port,
      path: "/mdevices/page/android",
    });

    wsService.shouldHandle = (request) => {
      return request.url?.startsWith("/mdevices/page/android") ?? false;
    };

    wsService.on("listening", () => {
      getDriverReportService()?.report("websocket_server_init_result", null, {
        result: "success",
        port: this.port,
      });
      if (option.callback) {
        option.callback();
      }
    });
    wsService.on("connection", this.handleConnection.bind(this));
    wsService.on("close", this.close.bind(this));
    this.server = wsService;
  }

  close() {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.websocketAppClients.forEach((client) => {
      client.close();
    });
    this.webClients.forEach((client) => {
      client.close();
    });
    this.server?.close();
  }

  handleDisconnect(id: number) {
    const client = this.websocketAppClients.get(id);
    if (client) {
      this.websocketAppClients.delete(id);
      this.controllerHost.emit?.("websocket-app-client-disconnected", id);
      this.controllerHost.emit?.("app-client-disconnected", id);
      this.controllerHost.handleWebSocketClientDisconnected?.(
        id,
        client.type(),
      );
    }
    const webClient = this.webClients.get(id);
    if (webClient) {
      this.webClients.delete(id);
      this.controllerHost.emit?.("websocket-web-client-disconnected", id);
      this.controllerHost.handleWebSocketClientDisconnected?.(
        id,
        webClient.type(),
      );
    }

    this.sendClientList();
  }

  async handleConnection(socket: WebSocket) {
    const info = await this.onConnection(socket);
    if (info === undefined) {
      socket.close();
      return;
    }

    const client = new WebSocketClient(this, info, socket);
    const response = {
      event: "RoomJoined",
      data: {
        room: this.roomId,
        id: info.id,
      },
    };
    client.sendMessage(JSON.stringify(response));

    if (info.type === "Driver") {
      this.webClients.set(info.id, client);
      this.controllerHost.emit?.("websocket-web-client-connected", client);
    } else {
      this.websocketAppClients.set(info.id, client);
      this.controllerHost.emit?.("websocket-app-client-connected", client);
      this.controllerHost.emit?.("app-client-connected", client);
    }
    this.controllerHost.handleWebSocketClientConnected?.(info.id, info.type);
    this.sendClientList();
  }

  onConnection(socket: WebSocket): Promise<WebSocketClientInfo | undefined> {
    return new Promise((resolve) => {
      const client_id = this.controllerHost.createClientId();
      const initMessage = {
        event: "Initialize",
        data: client_id,
      };
      const messageHandler = (data: string) => {
        const timer = setTimeout(() => {
          resolve(undefined);
        }, 5000);
        const response: any = JSON.parse(data);
        if (response.event === "Register") {
          const data = response.data;
          if (data && data.id === client_id) {
            const info: WebSocketClientInfo = {
              id: data.id,
              app: data.info?.app ?? "",
              debugRouterVersion: data.info?.debugRouterVersion ?? "",
              deviceModel: data.info?.deviceModel ?? "",
              network: "WiFi",
              osVersion: data.info?.osVersion ?? "",
              sdkVersion: data.info?.sdkVersion ?? "",
              type: data.type,
              raw_info: data.info,
            };
            socket.off("message", messageHandler);
            clearTimeout(timer);
            resolve(info);
          }
        }
      };
      socket.on("message", messageHandler);
      socket.send(JSON.stringify(initMessage));
    });
  }

  sendMessageToWeb(message: string) {
    this.webClients.forEach((client) => {
      client.sendMessage(message);
    });
  }

  sendMessageToWebClient(id: number, message: string) {
    this.webClients.get(id)?.sendMessage(message);
  }

  sendMessageToApp(id: number, message: string, fromWebClientId?: number) {
    if (
      fromWebClientId !== undefined &&
      this.controllerHost.handleWebSocketMessage
    ) {
      this.controllerHost.handleWebSocketMessage(fromWebClientId, id, message);
      return;
    }

    const client = this.websocketAppClients.get(id);
    if (client) {
      // send to ws client app
      client.sendMessage(message);
    } else {
      // send to usb client app
      this.controllerHost.handleWsMessage?.(id, message);
    }
  }

  handleWebSocketAppMessage(id: number, message: string) {
    if (this.controllerHost.handleWebSocketAppMessage) {
      this.controllerHost.handleWebSocketAppMessage(id, message);
      return;
    }

    this.sendMessageToWeb(message);
  }

  sendClientList() {
    this.webClients.forEach((client) => {
      client.handleListClients();
    });
  }

  sendDeviceList() {
    this.webClients.forEach((client) => {
      client.handleListClients();
    });
  }

  getAllUsbClients(): UsbClient[] {
    return this.controllerHost.getAllUsbClients();
  }

  getAllDevices(): Promise<BaseDevice[]> {
    return this.controllerHost.getDevices();
  }

  // return all websocket app clients
  getAllWebsocketAppClients() {
    return this.websocketAppClients;
  }

  getAllWebsocketWebClients() {
    return this.webClients;
  }

  emitEvent(
    event: keyof DebugerRouterDriverEvents,
    id: number,
    message: string,
  ) {
    this.controllerHost.emit?.(event, { id, message });
  }
}
