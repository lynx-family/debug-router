// Copyright 2024 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

import { EventEmitter } from "events";
import { UsbClient } from "../usb/Client";
import { BaseDevice } from "../device/BaseDevice";
import { DeviceManager } from "../device/DeviceManager";
import { DebugerRouterDriverEvents } from "../utils/type";
import { WebSocketController } from "../websocket/WebSocketServer";
import detectPort from "detect-port";
import { address } from "ip";
import { defaultLogger } from "../utils/logger";
import {
  getDriverReportService,
  DriverReportService,
  setDriverReportService,
} from "../report/interface/DriverReportService";
import { Client } from "./Client";
import { WebSocketClient } from "../websocket/WebSocketConnection";
import {
  MultiOpenCallback,
  MultiOpenStatus,
} from "./MultiOpenCallBack";
import fs from "fs";
import * as fslock from "../utils/file_lock";
import { DriverClient } from "./DriverClient";
import { createConnectionTraceRecorder } from "../trace/ConnectionTraceRecorder";
import type {
  ConnectionTraceNode,
  ConnectionTraceRecorder,
} from "../trace/ConnectionTraceRecorder";
import { LegacyMultiOpenGuard } from "./LegacyMultiOpenGuard";
import {
  PhysicalConnectorOption,
   PhysicalConnector,
} from "../physical/PhysicalConnector";


export type devOption = PhysicalConnectorOption & {
  enableMultiplexer?: boolean;
  multiplexerDaemonIdleTimeout?: number;
  enableWebSocket?: boolean;
  websocketOption?: {
    port?: number;
    roomId?: string;
  };
};

const DEFAULT_DEV_SERVE_PORT = 19783;

export class DebugRouterConnector {
  private enableMultiplexer: boolean;
  private multiplexerDaemonIdleTimeout: number;
  private physicalConnector: PhysicalConnector;
  private readonly events = new EventEmitter();
  reportService: DriverReportService | null = null;
  readonly devices: Map<string, BaseDevice> | undefined = undefined;
  readonly usbClients: Map<number, UsbClient> | undefined = undefined;
  readonly enableWebSocket;
  private selectedClient: UsbClient | undefined;
  private readonly driverClient: DriverClient;
  public readonly traceRecorder: ConnectionTraceRecorder | null = null;
  private readonly networkDeviceOpt:
    | {
        ip: string;
        port: number[];
      }
    | undefined;
  readonly adbOption: any;
  readonly hdcOption: any;
  readonly usbConnectOpt: {
    retryTime: number;
  };
  private closed: boolean = false;
  wssPort: number = DEFAULT_DEV_SERVE_PORT;
  wssHost: string | undefined;
  roomId: string | undefined;
  wss: WebSocketController | null = null;
  readonly legacyMultiOpenGuard: LegacyMultiOpenGuard;
  constructor(
    option: devOption = {
      enableMultiplexer: false,
      multiplexerDaemonIdleTimeout: 3000000,
      manualConnect: false,
      enableWebSocket: false, // deprecated
      enableAndroid: true,
      enableIOS: true,
      enableHarmony: true,
      enableDesktop: false,
      enableNetworkDevice: false,
      websocketOption: {},
      reportService: null,
    },
  ) {
    this.enableMultiplexer = option.enableMultiplexer ?? false;
    this.multiplexerDaemonIdleTimeout = option.multiplexerDaemonIdleTimeout ?? 3000000;
    setDriverReportService(option.reportService ?? null);
    getDriverReportService()?.init(option.manualConnect);

    /* if (this.enableMultiplexer) {
      // TODO enableMultiplexer is not supported now
      return ;
    } */

    this.legacyMultiOpenGuard = new LegacyMultiOpenGuard(() => this.disableAllClients());
    this.legacyMultiOpenGuard.prepareDriverDataDir();
    this.legacyMultiOpenGuard.startMonitorMultiOpen();
    this.traceRecorder = createConnectionTraceRecorder(
      option.connectionTrace,
      process.env.DriverConnectionTracePath,
    );

    this.physicalConnector = new PhysicalConnector({
      ...option,
      traceRecorder: this.traceRecorder,
      reportService: option.reportService,
    });
    this.devices = this.physicalConnector.devices;
    this.usbClients = this.physicalConnector.usbClients;
    this.selectedClient = this.physicalConnector.selectedClient;
    this.adbOption = this.physicalConnector.adbOption;
    this.hdcOption = this.physicalConnector.hdcOption;
    this.usbConnectOpt = this.physicalConnector.usbConnectOpt;

    this.enableWebSocket = option.enableWebSocket;
    this.roomId = option.websocketOption?.roomId;
    this.driverClient = new DriverClient(this.createClientId());
  }

  setMultiOpenCallback(callback: MultiOpenCallback) {
    this.legacyMultiOpenGuard.setMultiOpenCallback(callback);
  }

  disableAllClients() {
    this.physicalConnector.disableAllClients();
    this.getAllWebsocketAppClients().forEach((client) => {
      client.close();
    });
  }

  startWatchAllClients(force: boolean = true) {
    defaultLogger.debug("DebugRouterConnector startWatchAllClients");

    /* if(this.enableMultiplexer) {
      // TODO enableMultiplexer is not supported now
      return;
    } */

    if (!force && this.legacyMultiOpenGuard.currentStatus === MultiOpenStatus.attached) {
      defaultLogger.debug("startWatchAllClients: has already attached");
      return;
    }
    this.legacyMultiOpenGuard.currentStatus = MultiOpenStatus.unInit;
    fslock.clearLockFile();
    this.legacyMultiOpenGuard.monitorLatestDriverProcessFile();
    this.physicalConnector.startWatchAllClients();
   }

  createClientId(): number {
    return this.physicalConnector.createClientId();
  }

  async connectDevices(
    timeout: number = -1,
    serial: string | null = null,
    isAutoListenClients: boolean = true,
  ): Promise<BaseDevice[]> {
    return await this.physicalConnector.connectDevices(timeout, serial, isAutoListenClients);
  }

  // clientName:
  // for android: processName
  // for ios: AppName
  async connectUsbClients(
    deviceId: string,
    timeout: number = -1,
    waitTimeout: boolean = true,
    clientName: string | null = null,
  ): Promise<UsbClient[]> {
    return await this.physicalConnector.connectUsbClients(deviceId, timeout, waitTimeout, clientName);
  }

  selecteUsbClient(id: number) {
    this.physicalConnector.selecteUsbClient(id);
  }

  addDeviceManager(manager: DeviceManager) {
    this.physicalConnector.addDeviceManager(manager);
  }

  on<Event extends keyof DebugerRouterDriverEvents>(
    event: Event,
    callback: (payload: DebugerRouterDriverEvents[Event]) => void,
  ): void {
    this.events.on(event, callback);
  }

  off<Event extends keyof DebugerRouterDriverEvents>(
    event: Event,
    callback: (payload: DebugerRouterDriverEvents[Event]) => void,
  ): void {
    this.events.off(event, callback);
  }

  getConnectionTrace(limit?: number): ConnectionTraceNode[] {
    return this.traceRecorder?.getRecentNodes(limit) ?? [];
  }

  onConnectionTrace(listener: (node: ConnectionTraceNode) => void): () => void {
    if (!this.traceRecorder) {
      return () => {};
    }
    return this.traceRecorder.addListener(listener);
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    if (this.legacyMultiOpenGuard.multiOpenMonitorTimer) {
      clearInterval(this.legacyMultiOpenGuard.multiOpenMonitorTimer);
      this.legacyMultiOpenGuard.multiOpenMonitorTimer = undefined;
    }
    this.disableAllClients();
    if (this.wss) {
      this.wss.close();
      this.wss = null;
    }
    await new Promise((resolve) => setImmediate(resolve));
    await this.traceRecorder?.close();
  }

  emit<Event extends keyof DebugerRouterDriverEvents>(
    event: Event,
    payload: DebugerRouterDriverEvents[Event],
  ): void {
    if (event === "app-client-connected") {
      this.traceRecorder?.recordAppClientConnected(payload as Client);
    }
    if (event === "app-client-disconnected") {
      this.traceRecorder?.recordAppClientDisconnected(payload as number);
    }
    if (event === "websocket-app-client-connected") {
      this.traceRecorder?.recordWebsocketAppClientConnected(
        payload as WebSocketClient,
      );
    }
    if (event === "websocket-app-client-disconnected") {
      this.traceRecorder?.recordWebsocketAppClientDisconnected(
        payload as number,
      );
    }
    if (event === "websocket-web-client-connected") {
      this.traceRecorder?.recordWebsocketWebClientConnected(
        payload as WebSocketClient,
      );
    }
    if (event === "websocket-web-client-disconnected") {
      this.traceRecorder?.recordWebsocketWebClientDisconnected(
        payload as number,
      );
    }
    this.events.emit(event, payload);
  }

  registerDevice(device: BaseDevice) {
    this.physicalConnector.registerDevice(device,
      this.legacyMultiOpenGuard.currentStatus === MultiOpenStatus.attached);
  }

  unregisterDevice(serial: string) {
    this.physicalConnector.unregisterDevice(serial);
  }

  regiserUsbClient(client: UsbClient) {
    this.physicalConnector.regiserUsbClient(client);
  }

  unregiserUsbClient(id: number) {
    this.physicalConnector.unregiserUsbClient(id);
  }

  getDevices(
    timeout: number = -1,
    serial: string | null = null,
  ): Promise<BaseDevice[]> {
    return this.physicalConnector.getDevices(timeout, serial);
  }

  getAllUsbClients(): UsbClient[] {
    return this.physicalConnector.getAllUsbClients();
  }

  getDeviceUsbClients(
    deviceId: string,
    timeout: number = -1,
    clientName: string | null = null,
  ): Promise<UsbClient[]> {
    return this.physicalConnector.getDeviceUsbClients(deviceId, timeout, clientName);
  }

  handleUsbMessage(id: number, message: string) {
    if (this.wss) {
      const response = JSON.parse(message);
      if (response.data && response.data["sender"]) {
        response.data["sender"] = id;
      }
      if (
        response.data?.data &&
        response.data?.data.hasOwnProperty("client_id")
      ) {
        response.data.data["client_id"] = id;
      }
      this.wss.sendMessageToWeb(JSON.stringify(response));
    }
  }

  handleWsMessage(id: number, message: string) {
    const client = this.usbClients?.get(id);
    if (client) {
      const data = JSON.parse(message);
      if (
        data?.data?.type === "UsbConnect" ||
        data?.data?.type === "UsbConnectAck"
      )
        return;
      if (data?.data?.data?.client_id) {
        data.data.data.client_id = -1;
      }
      client.sendMessage(data);
    }
  }

  handleUsbClienChange() {
    if (this.wss) {
      this.wss.sendClientList();
    }
  }

  handleUsbDeviceChange() {
    if (this.wss) {
      this.wss.sendClientList();
    }
  }

  getAllWebsocketAppClients(): WebSocketClient[] {
    const clients = new Array();
    if (this.enableWebSocket && this.wss) {
      this.wss
        .getAllWebsocketAppClients()
        .forEach((client: WebSocketClient) => {
          clients.push(client);
        });
    }
    return clients;
  }

  getAllAppClients() {
    const clients: Client[] = [
      ...(this.physicalConnector.getAllUsbClients() as Client[]),
      ...(this.getAllWebsocketAppClients() as Client[]),
    ];
    return clients;
  }

  // send message to web platform
  sendMessageToWeb(message: string) {
    if (!this.enableWebSocket) {
      defaultLogger.warn("enableWebSocket isn't opened!");
      return;
    }
    if (this.wss === null) {
      defaultLogger.warn("websocket server hasn't started up");
      return;
    }
    this.wss.sendMessageToWeb(message);
  }

  // send message to app(include apps connected by usb and wifi)
  sendMessageToApp(id: number, message: string) {
    if (!this.enableWebSocket) {
      defaultLogger.warn("enableWebSocket isn't opened!");
      return;
    }
    if (this.wss === null) {
      defaultLogger.warn("websocket server hasn't started up");
      return;
    }
    this.wss?.sendMessageToApp(id, message);
  }

  async startWSServer(): Promise<void> {
    return new Promise(async (resolve) => {
      if (this.enableWebSocket) {
        const port = this.wssPort;
        this.wssPort = await detectPort(port);
        this.wssHost = `${address()}:${this.wssPort}`;
        getDriverReportService()?.report("websocket_server_init", null, {
          port: "wssPort:" + this.wssHost,
        });
        this.wss = new WebSocketController(this, {
          port: this.wssPort,
          host: this.wssHost,
          roomId: this.roomId,
          callback: resolve,
        });
      } else {
        resolve();
      }
    });
  }

  public getDriverClient(): DriverClient {
    return this.driverClient;
  }
}
