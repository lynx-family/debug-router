// Copyright 2024 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

import { EventEmitter } from "events";
import fs from "fs";
import path from "path";
import {
  getDriverReportService,
  DriverReportService,
  setDriverReportService,
} from "../report/interface/DriverReportService";
import {
  ConnectionTraceNode,
  ConnectionTraceRecorder,
  createConnectionTraceRecorder,
} from "../trace/ConnectionTraceRecorder";
import { DeviceManager } from "../device/DeviceManager";
import type { PhysicalConnectorOption } from "../physical/PhysicalConnector";
import { defaultLogger } from "../utils/logger";
import { driver_dir } from "../utils/file_lock";
import { DebugerRouterDriverEvents } from "../utils/type";
import { Client } from "./Client";
import { DriverClient } from "./DriverClient";
import { MultiOpenCallback, MultiOpenStatus } from "./MultiOpenCallBack";
import {
  ControlEvent,
  DeviceSnapshot,
  ClientSnapshot,
  Snapshot,
  WebSocketClientSnapshot,
  WebSocketServerInfo,
} from "../multiplexer/protocol";
import { MultiplexerDaemonClient } from "../multiplexer/client/MultiplexerDaemonClient";
import {
  DEFAULT_MULTIPLEXER_STARTUP_TIMEOUT,
  MultiplexerDaemonManager,
} from "../multiplexer/client/MultiplexerDaemonManager";
import { MultiplexerDiscovery } from "../multiplexer/client/MultiplexerDiscovery";
import { MultiplexerDevice, MultiplexerUsbClient } from "../multiplexer/client";
import { createMultiplexerPaths } from "../multiplexer/utils/paths";

const DEFAULT_DEV_SERVE_PORT = 19783;
const DEFAULT_MULTIPLEXER_DAEMON_IDLE_TIMEOUT = 600000;
const DEFAULT_MULTIPLEXER_STALE_TIMEOUT = 5000;
const DESIRED_RECOVERY_RETRY_DELAY_MS = 100;

type WebSocketServerCompat = {
  wssPath: string;
};

export type DebugRouterConnectorOption = PhysicalConnectorOption & {
  multiplexerDaemonIdleTimeout?: number;
  multiplexerStartupTimeout?: number;
  multiplexerStaleTimeout?: number;
  multiplexerRpcTimeout?: number;
  multiplexerRootDir?: string;
  multiplexerDataDir?: string;
  multiplexerDaemonEntry?: string;
  multiplexerLegacyDriverDir?: string;
  websocketOption?: {
    port?: number;
    roomId?: string;
  };
};

export type devOption = DebugRouterConnectorOption;

export class DebugRouterConnector {
  readonly devices: Map<string, MultiplexerDevice> = new Map();
  readonly usbClients: Map<number, MultiplexerUsbClient> = new Map();
  readonly enableWebSocket;
  reportService: DriverReportService | null = null;
  readonly traceRecorder: ConnectionTraceRecorder | null = null;
  wssPort: number;
  wssHost: string | undefined;
  roomId: string | undefined;
  wss: WebSocketServerCompat | null = null;

  private readonly events = new EventEmitter();
  private readonly daemonClient: MultiplexerDaemonClient;
  private readonly driverClient: DriverClient;
  private selectedClient: MultiplexerUsbClient | undefined;
  private readonly websocketAppClients: Map<
    number,
    WebSocketClientSnapshot
  > = new Map();
  private readonly websocketWebClients: Map<
    number,
    WebSocketClientSnapshot
  > = new Map();
  private nextClientId = 0;
  private multiOpenCallback: MultiOpenCallback | undefined;
  private multiOpenStatus = MultiOpenStatus.unInit;
  private closed = false;
  private webSocketServerStarted = false;
  private desiredWSServerStarted = false;
  private startingWSServer: Promise<void> | null = null;
  private desiredDeviceDiscoveryStarted = false;
  private desiredDeviceDiscoveryAutoListenClients = false;
  private desiredWatchAllClientsForce: boolean | undefined;
  private watchAllClientsStarted = false;
  private desiredRecoveryTimer: NodeJS.Timeout | null = null;
  private unsubscribeDaemonEvents: (() => void) | undefined;
  private unsubscribeDaemonConnectionState: (() => void) | undefined;

  constructor(
    option: DebugRouterConnectorOption = {
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
    setDriverReportService(option.reportService ?? null);
    getDriverReportService()?.init(option.manualConnect);
    const msg = "DebugRouterOption:" + JSON.stringify(option);
    defaultLogger.debug(msg);
    getDriverReportService()?.report(
      "DebugRouterConnectorInit",
      {},
      { option: msg },
    );
    if (!option.manualConnect) {
      getDriverReportService()?.report(
        "DriverInitOfNoManualConnect",
        {},
        { option: msg },
      );
    }

    this.traceRecorder = createConnectionTraceRecorder(
      option.connectionTrace,
      process.env.DriverConnectionTracePath,
    );

    this.enableWebSocket = option.enableWebSocket;
    this.wssPort = option.websocketOption?.port ?? DEFAULT_DEV_SERVE_PORT;
    this.roomId = option.websocketOption?.roomId;

    const paths = createMultiplexerPaths({
      rootDir: option.multiplexerRootDir,
      dataDir: option.multiplexerDataDir,
    });
    const staleTimeout =
      option.multiplexerStaleTimeout ?? DEFAULT_MULTIPLEXER_STALE_TIMEOUT;
    const discovery = new MultiplexerDiscovery({
      discoveryPath: paths.discoveryPath,
      staleTimeout,
    });
    const daemonManager = new MultiplexerDaemonManager({
      discovery,
      spawnLockPath: paths.spawnLockPath,
      daemonLockPath: paths.daemonLockPath,
      daemonEntry: option.multiplexerDaemonEntry ?? resolveDaemonEntryPath(),
      startupTimeout:
        option.multiplexerStartupTimeout ?? DEFAULT_MULTIPLEXER_STARTUP_TIMEOUT,
      staleTimeout,
      legacyDriverDir: option.multiplexerLegacyDriverDir ?? driver_dir,
      multiplexerDaemonIdleTimeout:
        option.multiplexerDaemonIdleTimeout ??
        DEFAULT_MULTIPLEXER_DAEMON_IDLE_TIMEOUT,
      enableWebSocket: option.enableWebSocket,
      websocketOption: option.websocketOption,
      physicalConnectorOption: createDaemonPhysicalConnectorOption(option),
    });

    this.daemonClient = new MultiplexerDaemonClient({
      daemonManager,
      rpcTimeout: option.multiplexerRpcTimeout,
    });
    this.unsubscribeDaemonEvents = this.daemonClient.subscribe((event) =>
      this.applyHostEvent(event),
    );
    this.unsubscribeDaemonConnectionState =
      this.daemonClient.subscribeConnectionState((state) => {
        if (state.state === "disconnected") {
          this.handleDaemonDisconnected();
          return;
        }
      });

    this.driverClient = new DriverClient(this.createClientId());

    if (!option.manualConnect) {
      void this.connectDevices();
    }
  }

  setMultiOpenCallback(callback: MultiOpenCallback): void {
    this.multiOpenCallback = callback;
  }

  disableAllClients(): void {
    this.selectedClient = undefined;
    defaultLogger.warn(
      "disableAllClients is ignored by the Multiplexer-only DebugRouterConnector; device and client ownership is shared by the daemon.",
    );
  }

  startWatchAllClients(force: boolean = true): void {
    this.desiredWatchAllClientsForce = force;
    void this.reacquireLegacyOwnership()
      .then(() => this.ensureWatchAllClientsStarted(force))
      .catch((error: Error) => {
        defaultLogger.warn(
          `Failed to start multiplexer client watchers: ${error.message}`,
        );
        this.scheduleDesiredRecovery();
      });
  }

  private async ensureWatchAllClientsStarted(force: boolean): Promise<void> {
    await this.daemonClient.call("startWatchAllClients", { force });
    this.watchAllClientsStarted = true;
  }

  private async reacquireLegacyOwnership(): Promise<void> {
    await this.daemonClient.call("reacquireLegacyOwnership", {});
  }

  private restoreDesiredWatchAllClients(): Promise<void> | undefined {
    if (
      this.desiredWatchAllClientsForce === undefined ||
      this.watchAllClientsStarted
    ) {
      return undefined;
    }

    return this.ensureWatchAllClientsStarted(this.desiredWatchAllClientsForce);
  }

  createClientId(): number {
    if (this.nextClientId > 4294967294) {
      this.nextClientId = 0;
    }
    return ++this.nextClientId;
  }

  async connectDevices(
    timeout: number = -1,
    serial: string | null = null,
    isAutoListenClients: boolean = true,
  ): Promise<MultiplexerDevice[]> {
    this.desiredDeviceDiscoveryStarted = true;
    if (isAutoListenClients) {
      this.desiredDeviceDiscoveryAutoListenClients = true;
    }
    await this.reacquireLegacyOwnership();
    const snapshots = await this.daemonClient.call("connectDevices", {
      timeout,
      serial,
      isAutoListenClients,
    });

    return this.upsertDeviceSnapshots(snapshots);
  }

  async connectUsbClients(
    deviceId: string,
    timeout: number = -1,
    waitTimeout: boolean = true,
    clientName: string | null = null,
  ): Promise<MultiplexerUsbClient[]> {
    const snapshots = await this.daemonClient.call("connectUsbClients", {
      deviceId,
      timeout,
      waitTimeout,
      clientName,
    });

    return this.upsertClientSnapshots(snapshots);
  }

  selecteUsbClient(id: number): void {
    if (this.usbClients.has(id)) {
      this.selectedClient = this.usbClients.get(id);
    }
  }

  addDeviceManager(_manager: DeviceManager): void {
    defaultLogger.warn(
      "addDeviceManager is ignored by the Multiplexer-only DebugRouterConnector; physical device managers live in the daemon.",
    );
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
    this.unsubscribeDaemonEvents?.();
    this.unsubscribeDaemonEvents = undefined;
    this.unsubscribeDaemonConnectionState?.();
    this.unsubscribeDaemonConnectionState = undefined;
    this.clearDesiredRecoveryTimer();
    await this.daemonClient.close();
    this.clearWSServerMirror();
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
      this.traceRecorder?.recordWebsocketAppClientConnected(payload as any);
    }
    if (event === "websocket-app-client-disconnected") {
      this.traceRecorder?.recordWebsocketAppClientDisconnected(
        payload as number,
      );
    }
    if (event === "websocket-web-client-connected") {
      this.traceRecorder?.recordWebsocketWebClientConnected(payload as any);
    }
    if (event === "websocket-web-client-disconnected") {
      this.traceRecorder?.recordWebsocketWebClientDisconnected(
        payload as number,
      );
    }
    this.events.emit(event, payload);
  }

  registerDevice(device: MultiplexerDevice): void {
    const existing = this.devices.get(device.serial);
    if (existing) {
      defaultLogger.debug("registerDevice: has exists:" + device.serial);
      return;
    }

    defaultLogger.debug("register new device:" + device.serial);
    this.devices.set(device.serial, device);
    this.traceRecorder?.recordDeviceRegistered(device.serial, {
      os: device.info.os,
      title: device.info.title,
    });
    this.emit("device-connected", device as any);
  }

  unregisterDevice(serial: string): void {
    this.unregisterDeviceInternal(serial, false);
  }

  regiserUsbClient(client: MultiplexerUsbClient): void {
    defaultLogger.debug(
      "regiserUsbClient:" + " info:" + JSON.stringify(client.info),
    );
    const existing = this.usbClients.get(client.clientId());
    if (existing) {
      defaultLogger.debug("regiserUsbClient: has exist:" + client.clientId());
      return;
    }

    this.usbClients.set(client.clientId(), client);
    this.emit("client-connected", client as any);
    this.emit("app-client-connected", client as any);
    this.handleUsbClienChange();
  }

  unregiserUsbClient(id: number): void {
    this.unregisterUsbClientInternal(id, true);
  }

  getDevices(
    timeout: number = -1,
    serial: string | null = null,
  ): Promise<MultiplexerDevice[]> {
    return new Promise((resolve) => {
      if (timeout < 0) {
        resolve(this.findDevice(serial));
        return;
      }

      const deviceCallback = (device: MultiplexerDevice) => {
        if (device.serial === serial) {
          resolve([device]);
          this.off("device-connected", deviceCallback as any);
        }
      };

      if (serial !== null) {
        const targetDevices = this.findDevice(serial);
        if (targetDevices.length > 0) {
          resolve(targetDevices);
          return;
        }
        this.on("device-connected", deviceCallback as any);
      }

      setTimeout(() => {
        this.off("device-connected", deviceCallback as any);
        resolve(this.findDevice(serial));
      }, timeout);
    });
  }

  getAllUsbClients(): MultiplexerUsbClient[] {
    return Array.from(this.usbClients.values());
  }

  async getDeviceUsbClients(
    deviceId: string,
    timeout: number = -1,
    clientName: string | null = null,
  ): Promise<MultiplexerUsbClient[]> {
    return new Promise((resolve) => {
      if (!this.devices.has(deviceId)) {
        defaultLogger.debug("getDeviceUsbClients: has" + deviceId);
        resolve([]);
        return;
      }

      if (timeout < 0) {
        resolve(this.findDeviceUsbClients(deviceId, clientName));
        return;
      }

      const clientCallback = (client: MultiplexerUsbClient) => {
        if (client.deviceId() !== deviceId) {
          return;
        }
        if (this.isTargetClient(client, clientName)) {
          resolve([client]);
          this.off("client-connected", clientCallback as any);
        }
      };

      if (clientName != null) {
        const targetClients = this.findDeviceUsbClients(deviceId, clientName);
        if (targetClients.length > 0) {
          resolve(targetClients);
          return;
        }
        this.on("client-connected", clientCallback as any);
      }

      setTimeout(() => {
        this.off("client-connected", clientCallback as any);
        resolve(this.findDeviceUsbClients(deviceId, clientName));
      }, timeout);
    });
  }

  handleUsbMessage(id: number, message: string): void {
    const client = this.usbClients.get(id);
    this.emit("usb-client-message", { id, message } as any);
    client?.handleMessage(message);
  }

  handleWsMessage(id: number, message: string): void {
    const client = this.usbClients.get(id);
    if (!client) {
      return;
    }

    const data = JSON.parse(message);
    if (
      data?.data?.type === "UsbConnect" ||
      data?.data?.type === "UsbConnectAck"
    ) {
      return;
    }
    if (data?.data?.data?.client_id) {
      data.data.data.client_id = -1;
    }
    void this.daemonClient
      .call("sendMessageToApp", { id, message: JSON.stringify(data) })
      .catch((error: Error) => {
        defaultLogger.warn(
          `Failed to route websocket message to app through multiplexer host: ${error.message}`,
        );
      });
  }

  handleUsbClienChange(): void {
    // Client-list fanout is owned by the daemon-side WebSocket controller.
  }

  handleUsbDeviceChange(): void {
    // Device-list fanout is owned by the daemon-side WebSocket controller.
  }

  getAllWebsocketAppClients(): WebSocketClientSnapshot[] {
    return Array.from(this.websocketAppClients.values());
  }

  getAllAppClients(): Client[] {
    const clients: Client[] = [...Array.from(this.usbClients.values())];
    this.getAllWebsocketAppClients().forEach((client) => {
      clients.push(client as any);
    });
    return clients;
  }

  sendMessageToWeb(message: string): void {
    if (!this.enableWebSocket) {
      defaultLogger.warn("enableWebSocket isn't opened!");
      return;
    }
    if (!this.webSocketServerStarted) {
      defaultLogger.warn("websocket server hasn't started up");
      return;
    }
    void this.daemonClient
      .call("sendMessageToWeb", { message })
      .catch((error: Error) => {
        defaultLogger.warn(
          `Failed to send multiplexer message to web: ${error.message}`,
        );
      });
  }

  sendMessageToApp(id: number, message: string): void {
    if (!this.enableWebSocket) {
      defaultLogger.warn("enableWebSocket isn't opened!");
      return;
    }
    if (!this.webSocketServerStarted) {
      defaultLogger.warn("websocket server hasn't started up");
      return;
    }
    void this.daemonClient
      .call("sendMessageToApp", { id, message })
      .catch((error: Error) => {
        defaultLogger.warn(
          `Failed to send multiplexer message to app: ${error.message}`,
        );
      });
  }

  async startWSServer(): Promise<void> {
    if (!this.enableWebSocket) {
      return;
    }
    this.desiredWSServerStarted = true;
    try {
      await this.ensureWSServerStarted();
    } catch (error) {
      this.scheduleDesiredRecovery();
      throw error;
    }
  }

  private ensureWSServerStarted(): Promise<void> {
    if (!this.enableWebSocket || this.closed) {
      return Promise.resolve();
    }
    if (this.startingWSServer) {
      return this.startingWSServer;
    }

    this.startingWSServer = this.daemonClient
      .call("startWSServer", {})
      .then((info) => {
        if (!info) {
          this.clearWSServerMirror();
          return;
        }

        this.applyWebSocketServerInfo(info);
      })
      .finally(() => {
        this.startingWSServer = null;
      });

    return this.startingWSServer;
  }

  private applyWebSocketServerInfo(info: WebSocketServerInfo): void {
    this.wssPort = info.port;
    this.wssHost = info.host;
    this.roomId = info.roomId;
    this.wss = {
      wssPath: `ws://${info.host}/mdevices/page/android`,
    };
    this.webSocketServerStarted = true;
  }

  private clearWSServerMirror(): void {
    this.wss = null;
    this.webSocketServerStarted = false;
  }

  private handleDaemonDisconnected(): void {
    this.clearDaemonMirrors();
    this.scheduleDesiredRecovery();
  }

  private scheduleDesiredRecovery(): void {
    if (this.closed) {
      return;
    }
    if (this.desiredRecoveryTimer) {
      return;
    }

    this.desiredRecoveryTimer = setTimeout(() => {
      this.desiredRecoveryTimer = null;
      void this.restoreDesiredState()
        .catch((error: Error) => {
          defaultLogger.warn(
            `Failed to restore desired multiplexer state after daemon reconnect: ${error.message}`,
          );
          this.scheduleDesiredRecovery();
        });
    }, DESIRED_RECOVERY_RETRY_DELAY_MS);
  }

  private async restoreDesiredState(): Promise<void> {
    await this.daemonClient.connect();
    await this.restoreDesiredDeviceDiscovery();

    const watchAllClients = this.restoreDesiredWatchAllClients();
    if (watchAllClients) {
      await watchAllClients;
    }
    if (this.desiredWSServerStarted && !this.webSocketServerStarted) {
      await this.ensureWSServerStarted();
    }
  }

  private async restoreDesiredDeviceDiscovery(): Promise<void> {
    if (!this.desiredDeviceDiscoveryStarted) {
      return;
    }

    await this.reacquireLegacyOwnership();
    const snapshots = await this.daemonClient.call("connectDevices", {
      timeout: -1,
      serial: null,
      isAutoListenClients: this.desiredDeviceDiscoveryAutoListenClients,
    });
    this.upsertDeviceSnapshots(snapshots);
  }

  private clearDesiredRecoveryTimer(): void {
    if (this.desiredRecoveryTimer) {
      clearTimeout(this.desiredRecoveryTimer);
      this.desiredRecoveryTimer = null;
    }
  }

  private clearDaemonMirrors(): void {
    this.clearWSServerMirror();
    this.watchAllClientsStarted = false;

    for (const id of Array.from(this.usbClients.keys())) {
      this.unregisterUsbClientInternal(id, true);
    }
    for (const id of Array.from(this.websocketAppClients.keys())) {
      this.websocketAppClients.delete(id);
      this.emit("websocket-app-client-disconnected", id as any);
      this.emit("app-client-disconnected", id as any);
    }
    for (const id of Array.from(this.websocketWebClients.keys())) {
      this.websocketWebClients.delete(id);
      this.emit("websocket-web-client-disconnected", id as any);
    }
    for (const serial of Array.from(this.devices.keys())) {
      this.unregisterDeviceInternal(serial, false);
    }
  }

  getDriverClient(): DriverClient {
    return this.driverClient;
  }

  applySnapshot(snapshot: Snapshot): void {
    this.syncDeviceSnapshots(snapshot.devices);
    this.syncClientSnapshots(snapshot.clients);
  }

  applyHostEvent(event: ControlEvent): void {
    switch (event.event) {
      case "snapshot":
        this.applySnapshot(event.data);
        break;
      case "legacy-ownership-changed":
        this.applyLegacyOwnershipChange(event.data.status);
        break;
      case "device-connected": {
        const device = MultiplexerDevice.fromSnapshot(
          event.data,
          this.daemonClient,
        );
        this.registerDevice(device);
        break;
      }
      case "device-disconnected":
        this.unregisterDeviceInternal(event.data.serial, false);
        break;
      case "client-connected": {
        const client = MultiplexerUsbClient.fromSnapshot(
          event.data,
          this.daemonClient,
        );
        this.regiserUsbClient(client);
        break;
      }
      case "client-disconnected":
        this.unregisterUsbClientInternal(event.data.id, true);
        break;
      case "usb-client-message":
        this.handleUsbMessage(event.data.id, event.data.message);
        break;
      case "ws-client-message":
        this.emit("ws-client-message", event.data as any);
        break;
      case "ws-web-message":
        this.emit("ws-web-message", event.data as any);
        break;
      case "websocket-app-client-connected":
        this.websocketAppClients.set(event.data.id, event.data);
        this.emit("websocket-app-client-connected", event.data as any);
        this.emit("app-client-connected", event.data as any);
        break;
      case "websocket-app-client-disconnected":
        this.websocketAppClients.delete(event.data.id);
        this.emit("websocket-app-client-disconnected", event.data.id as any);
        this.emit("app-client-disconnected", event.data.id as any);
        break;
      case "websocket-web-client-connected":
        this.websocketWebClients.set(event.data.id, event.data);
        this.emit("websocket-web-client-connected", event.data as any);
        break;
      case "websocket-web-client-disconnected":
        this.websocketWebClients.delete(event.data.id);
        this.emit("websocket-web-client-disconnected", event.data.id as any);
        break;
    }
  }

  private syncDeviceSnapshots(snapshots: DeviceSnapshot[]): void {
    const activeSerials = new Set(snapshots.map((snapshot) => snapshot.serial));
    this.upsertDeviceSnapshots(snapshots);

    for (const serial of Array.from(this.devices.keys())) {
      if (!activeSerials.has(serial)) {
        this.unregisterDeviceInternal(serial, false);
      }
    }
  }

  private applyLegacyOwnershipChange(
    status: "attached" | "unattached",
  ): void {
    const nextStatus =
      status === "attached"
        ? MultiOpenStatus.attached
        : MultiOpenStatus.unattached;

    if (this.multiOpenStatus === nextStatus) {
      return;
    }

    this.multiOpenStatus = nextStatus;
    if (nextStatus === MultiOpenStatus.unattached) {
      this.watchAllClientsStarted = false;
      this.selectedClient = undefined;
    }
    this.multiOpenCallback?.statusChanged?.(nextStatus);
  }

  private syncClientSnapshots(snapshots: Snapshot["clients"]): void {
    const activeIds = new Set(snapshots.map((snapshot) => snapshot.id));
    this.upsertClientSnapshots(snapshots);

    for (const id of Array.from(this.usbClients.keys())) {
      if (!activeIds.has(id)) {
        this.unregisterUsbClientInternal(id, true);
      }
    }
  }

  private upsertDeviceSnapshots(
    snapshots: DeviceSnapshot[],
  ): MultiplexerDevice[] {
    return snapshots.map((snapshot) => this.upsertDeviceSnapshot(snapshot));
  }

  private upsertDeviceSnapshot(snapshot: DeviceSnapshot): MultiplexerDevice {
    const existing = this.devices.get(snapshot.serial);
    if (existing) {
      existing.updateFromSnapshot(snapshot);
      return existing;
    }

    const device = MultiplexerDevice.fromSnapshot(snapshot, this.daemonClient);
    this.registerDevice(device);
    return device;
  }

  private upsertClientSnapshots(
    snapshots: Snapshot["clients"],
  ): MultiplexerUsbClient[] {
    return snapshots.map((snapshot) => this.upsertClientSnapshot(snapshot));
  }

  private upsertClientSnapshot(snapshot: ClientSnapshot): MultiplexerUsbClient {
    const existing = this.usbClients.get(snapshot.id);
    if (existing) {
      existing.updateFromSnapshot(snapshot);
      return existing;
    }

    const client = MultiplexerUsbClient.fromSnapshot(
      snapshot,
      this.daemonClient,
    );
    this.regiserUsbClient(client);
    return client;
  }

  private findDevice(serial: string | null): MultiplexerDevice[] {
    let targetDevices = Array.from(this.devices.values());
    if (serial === null) {
      return targetDevices;
    }

    targetDevices = targetDevices.filter((device) => {
      return device.serial === serial;
    });
    return targetDevices;
  }

  private findDeviceUsbClients(
    deviceId: string,
    clientName: string | null,
  ): MultiplexerUsbClient[] {
    const clients = Array.from(this.usbClients.values()).filter((client) => {
      return client.deviceId() === deviceId;
    });
    return this.findUsbClient(clientName, clients);
  }

  private findUsbClient(
    clientName: string | null,
    clients: MultiplexerUsbClient[],
  ): MultiplexerUsbClient[] {
    if (clientName === null) {
      return clients;
    }

    return clients.filter((client) => {
      return this.isTargetClient(client, clientName);
    });
  }

  private isTargetClient(
    client: MultiplexerUsbClient,
    clientName: string | null,
  ): boolean {
    if (clientName == null) {
      return false;
    }
    if (
      client?.info?.query?.os === "Android" &&
      client.info.query.raw_info?.AppProcessName === clientName
    ) {
      return true;
    }
    if (
      client?.info?.query?.device_model?.indexOf("iPhone") !== -1 &&
      client.info.query.raw_info?.App === clientName
    ) {
      return true;
    }
    return false;
  }

  private unregisterDeviceInternal(
    serial: string,
    disconnect: boolean,
    emitEvent: boolean = true,
  ): void {
    const device = this.devices.get(serial);
    if (!device) {
      defaultLogger.debug(
        "unregisterDevice warning: no existed device:" + serial,
      );
      return;
    }

    defaultLogger.debug("unregisterDevice:" + serial);
    this.traceRecorder?.recordDeviceUnregistered(serial, {
      os: device.info.os,
      title: device.info.title,
    });
    this.devices.delete(serial);
    if (disconnect) {
      device.disConnect();
    }
    if (emitEvent) {
      this.emit("device-disconnected", device as any);
    }
  }

  private unregisterUsbClientInternal(id: number, emitEvent: boolean): void {
    const existing = this.usbClients.get(id);
    if (!existing) {
      defaultLogger.debug("unregiserUsbClient unknown id:" + id);
      return;
    }

    defaultLogger.debug("unregiserUsbClient:" + JSON.stringify(existing.info));
    if (this.selectedClient?.clientId() === id) {
      this.selectedClient = undefined;
    }
    this.usbClients.delete(id);
    if (emitEvent) {
      this.emit("client-disconnected", id as any);
      this.emit("app-client-disconnected", id as any);
      this.handleUsbClienChange();
    }
  }
}

function resolveDaemonEntryPath(): string {
  const packageDaemonEntry =
    "@lynx-js/debug-router-connector/dist/cjs/src/multiplexer/daemon/entry.js";
  const defaultDaemonEntry = path.resolve(
    __dirname,
    "../multiplexer/daemon/entry.js",
  );
  const candidates = [
    defaultDaemonEntry,
    path.resolve(__dirname, "../../dist/cjs/src/multiplexer/daemon/entry.js"),
    resolvePackagePath(packageDaemonEntry, [__dirname, process.cwd()]),
    resolveTransitivePackagePath(
      "@byted-lynx/debug-router-driver/package.json",
      packageDaemonEntry,
    ),
  ];

  return (
    candidates.find(
      (candidate): candidate is string =>
        candidate !== undefined && fs.existsSync(candidate),
    ) ?? defaultDaemonEntry
  );
}

function resolvePackagePath(
  specifier: string,
  paths?: string[],
): string | undefined {
  try {
    return require.resolve(specifier, paths ? { paths } : undefined);
  } catch (_error) {
    return undefined;
  }
}

function resolveTransitivePackagePath(
  parentPackageJson: string,
  specifier: string,
): string | undefined {
  const parent = resolvePackagePath(parentPackageJson, [
    __dirname,
    process.cwd(),
  ]);
  if (!parent) {
    return undefined;
  }

  return resolvePackagePath(specifier, [path.dirname(parent)]);
}

function createDaemonPhysicalConnectorOption(
  option: DebugRouterConnectorOption,
): PhysicalConnectorOption {
  return {
    manualConnect: option.manualConnect,
    enableWebSocket: option.enableWebSocket,
    enableAndroid: option.enableAndroid,
    enableIOS: option.enableIOS,
    enableHarmony: option.enableHarmony,
    enableDesktop: option.enableDesktop,
    enableNetworkDevice: option.enableNetworkDevice,
    adbHostPort: option.adbHostPort,
    hdcHostPort: option.hdcHostPort,
    usbConnectOpt: option.usbConnectOpt,
    networkDeviceOpt: option.networkDeviceOpt,
    reportService: null,
  };
}
