// Copyright 2024 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

import { WebSocket, WebSocketServer } from "ws";
import { errorMonitor } from "events";
import { WebSocketClientInfo, WebSocketClient } from "./WebSocketConnection";
import { DebugRouterConnector } from "../connector";
import { UsbClient } from "../usb/Client";
import { BaseDevice } from "../device/BaseDevice";
import { getDriverReportService } from "../report/interface/DriverReportService";
import { DebugerRouterDriverEvents } from "../utils/type";

export class WebSocketController {
  private driver: DebugRouterConnector;
  private port: number;
  private host: string;
  private roomId: string;
  private wssPath: string;
  private server: WebSocketServer;
  // websocketAppClients
  private websocketAppClients: Map<number, WebSocketClient> = new Map();
  // web clients
  private webClients: Map<number, WebSocketClient> = new Map();

  constructor(
    driver: DebugRouterConnector,
    option: {
      port: number;
      host: string;
      roomId?: string;
      callback?: () => void;
    },
  ) {
    this.driver = driver;
    this.port = option.port;
    this.host = option.host;
    this.wssPath = `ws://${this.host}/mdevices/page/android`;
    this.roomId = option.roomId ?? "";
    this.driver.traceRecorder?.record(
      "websocket_server",
      "starting",
      undefined,
      { host: this.host, port: this.port },
    );
    const wsService = new WebSocketServer({
      port: this.port,
      path: "/mdevices/page/android",
    });

    wsService.shouldHandle = (request) => {
      return request.url?.startsWith("/mdevices/page/android") ?? false;
    };

    wsService.on(errorMonitor, (error) =>
      this.driver.traceRecorder?.record(
        "websocket_server",
        "failed",
        undefined,
        { port: this.port, step: "listen" },
        error,
      ),
    );
    wsService.on("listening", () => {
      this.driver.traceRecorder?.record(
        "websocket_server",
        "listening",
        undefined,
        { address: wsService.address() },
      );
      getDriverReportService()?.report("websocket_server_init_result", null, {
        result: "success",
        port: this.port,
      });
      if (option.callback) {
        option.callback();
      }
    });
    wsService.on("connection", this.handleConnection.bind(this));
    wsService.on("close", () => {
      this.driver.traceRecorder?.record(
        "websocket_server",
        "closed",
        undefined,
        { port: this.port },
      );
      this.close();
    });
    this.server = wsService;
  }

  close() {
    this.websocketAppClients.forEach((client) => {
      client.close();
    });
    this.webClients.forEach((client) => {
      client.close();
    });
  }

  handleDisconnect(id: number) {
    const client = this.websocketAppClients.get(id);
    if (client) {
      this.websocketAppClients.delete(id);
      this.driver.emit("websocket-app-client-disconnected", id);
      this.driver.emit("app-client-disconnected", id);
    }
    const webClient = this.webClients.get(id);
    if (webClient) {
      this.webClients.delete(id);
      this.driver.emit("websocket-web-client-disconnected", id);
    }

    this.sendClientList();
  }

  async handleConnection(socket: WebSocket) {
    this.driver.traceRecorder?.socket(
      socket,
      { transport: "websocket", port: this.port },
      undefined,
      null,
      true,
    );
    const info = await this.onConnection(socket);
    if (info === undefined) {
      this.driver.traceRecorder?.connection(
        socket,
        "failed",
        "register",
        "Registration did not complete before the existing deadline",
      );
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
      this.driver.emit("websocket-web-client-connected", client);
    } else {
      this.websocketAppClients.set(info.id, client);
      this.driver.emit("websocket-app-client-connected", client);
      this.driver.emit("app-client-connected", client);
    }
    this.sendClientList();
  }

  onConnection(socket: WebSocket): Promise<WebSocketClientInfo | undefined> {
    return new Promise((resolve) => {
      const client_id = this.driver.createClientId();
      const initMessage = {
        event: "Initialize",
        data: client_id,
      };
      const messageHandler = (data: string) => {
        const timer = setTimeout(() => {
          resolve(undefined);
        }, 5000);
        let response: any;
        try {
          response = JSON.parse(data);
        } catch (error) {
          this.driver.traceRecorder?.connection(
            socket,
            "failed",
            "register",
            error,
          );
          throw error;
        }
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
            this.driver.traceRecorder?.register(socket, info);
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

  sendMessageToApp(id: number, message: string) {
    const client = this.websocketAppClients.get(id);
    if (client) {
      // send to ws client app
      client.sendMessage(message);
    } else {
      // send to usb client app
      this.driver.handleWsMessage(id, message);
    }
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
    return this.driver.getAllUsbClients();
  }

  getAllDevices(): Promise<BaseDevice[]> {
    return this.driver.getDevices();
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
    this.driver.emit(event, { id, message });
  }
}
