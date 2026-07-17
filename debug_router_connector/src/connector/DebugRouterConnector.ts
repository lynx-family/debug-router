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
import { DeviceManager } from "../device/DeviceManager";
import type { PhysicalConnectorOption } from "../physical/PhysicalConnector";
import { defaultLogger } from "../utils/logger";
import { driver_dir } from "../utils/file_lock";
import { DebugerRouterDriverEvents, DeviceOS } from "../utils/type";
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
import { MultiplexerWebSocketClient } from "../multiplexer/client/MultiplexerWebSocketClient";
import { createMultiplexerPaths } from "../multiplexer/utils/paths";

const DEFAULT_DEV_SERVE_PORT = 19783;
const DEFAULT_MULTIPLEXER_DAEMON_IDLE_TIMEOUT = 600000;
const DEFAULT_MULTIPLEXER_STALE_TIMEOUT = 5000;
const DESIRED_RECOVERY_RETRY_DELAY_MS = 100;

type WebSocketServerCompat = {
  wssPath: string;
};

/**
 * About forceRespawnDaemon:
 * Debug/test-only escape hatch for daemon-global configuration.
 *
 * On this Connector's first daemon access, stop the daemon currently using
 * the same multiplexerDataDir and spawn a new daemon from this Connector's
 * daemon entry and daemon-global options. The replacement is one-shot and
 * disconnects every Connector sharing that daemon. Unlike normal shared
 * daemon startup, the replacement uses this Connector's manualConnect and
 * capability enable flags exactly, so disabled-capability scenarios can be
 * tested. Closing this Connector force-stops the daemon and removes its
 * discovery/lock artifacts instead of waiting for the daemon idle timeout.
 * Close never starts or reconnects a daemon, but it still cleans up a daemon
 * and artifacts already present in the selected multiplexerDataDir.
 *
 * For deterministic tests, prefer:
 *   manualConnect: true,
 *   forceRespawnDaemon: true,
 * followed by `await connector.connectDevices()`.
 */

export type DebugRouterConnectorOption = PhysicalConnectorOption & {
  forceRespawnDaemon?: boolean;
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
  wssPort: number;
  wssHost: string | undefined;
  roomId: string | undefined;
  wss: WebSocketServerCompat | null = null;

  private readonly events = new EventEmitter();
  private readonly daemonClient: MultiplexerDaemonClient;
  private readonly driverClient: DriverClient;
  private readonly enableAndroid: boolean;
  private readonly enableIOS: boolean;
  private readonly enableHarmony: boolean;
  private readonly enableDesktop: boolean;
  private readonly enableNetworkDevice: boolean;
  private readonly forceRespawnDaemon: boolean;
  private selectedClient: MultiplexerUsbClient | undefined;
  private readonly websocketAppClients: Map<
    number,
    MultiplexerWebSocketClient
  > = new Map();
  private readonly websocketWebClients: Map<
    number,
    MultiplexerWebSocketClient
  > = new Map();
  private readonly hiddenUsbClientIds = new Set<number>();
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
    /**
     * Connector enable flags are normally instance-local. The shared daemon
     * keeps the full set of generally available capabilities enabled, while
     * each Connector filters the devices, clients, snapshots, and events it
     * exposes. forceRespawnDaemon is the debug/test exception: its replacement
     * daemon receives this Connector's enable and manualConnect values exactly.
     *
     * Options without merge semantics (for example websocketOption,
     * adbHostPort, hdcHostPort, networkDeviceOpt, retry/trace output, daemon
     * idle/stale timeouts, and legacyDriverDir) remain daemon-global. A healthy
     * daemon keeps its existing values; use forceRespawnDaemon only when a
     * debug/test scenario intentionally needs this Connector's values to win.
     */
    option: DebugRouterConnectorOption = {
      manualConnect: false,
      forceRespawnDaemon: false,
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

    this.enableWebSocket = option.enableWebSocket ?? false;
    this.enableAndroid = option.enableAndroid ?? true;
    this.enableIOS = option.enableIOS ?? true;
    this.enableHarmony = option.enableHarmony ?? true;
    this.enableDesktop = option.enableDesktop ?? false;
    this.enableNetworkDevice = option.enableNetworkDevice ?? false;
    this.forceRespawnDaemon = option.forceRespawnDaemon ?? false;
    this.wssPort = option.websocketOption?.port ?? DEFAULT_DEV_SERVE_PORT;
    this.roomId = option.websocketOption?.roomId;
    if (this.forceRespawnDaemon) {
      defaultLogger.warn(
        "forceRespawnDaemon is enabled; the first daemon access will replace the daemon shared by this multiplexerDataDir using this Connector's local daemon entry and exact capability configuration, and closing this Connector will force-stop that daemon and clean its artifacts.",
      );
    }

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
      forceRespawnDaemon: this.forceRespawnDaemon,
      enableWebSocket: this.forceRespawnDaemon ? this.enableWebSocket : true,
      websocketOption: option.websocketOption,
      physicalConnectorOption: createDaemonPhysicalConnectorOption(
        option,
        this.forceRespawnDaemon,
      ),
    });

    this.daemonClient = new MultiplexerDaemonClient({
      daemonManager,
      rpcTimeout: option.multiplexerRpcTimeout,
    });
    this.unsubscribeDaemonEvents = this.daemonClient.subscribe((event) =>
      this.applyHostEvent(event),
    );
    this.unsubscribeDaemonConnectionState = this.daemonClient.subscribeConnectionState(
      (state) => {
        if (state.state === "disconnected") {
          this.handleDaemonDisconnected();
          return;
        }
      },
    );

    this.driverClient = new DriverClient(this.createClientId());

    if (!option.manualConnect) {
      void this.connectDevices().catch((error: Error) => {
        defaultLogger.warn(
          `Failed to auto-connect multiplexer devices: ${error.message}`,
        );
        this.scheduleDesiredRecovery();
      });
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
    if (this.forceRespawnDaemon) {
      try {
        defaultLogger.info(
          "forceRespawnDaemon Connector is closing; force-stopping the current daemon and cleaning its artifacts.",
        );
        await this.daemonClient.forceStopDaemon();
      } catch (error) {
        defaultLogger.warn(
          `Failed to force-stop daemon while closing forceRespawnDaemon Connector: ${
            (error as Error).message
          }`,
        );
      }
    }
    await this.daemonClient.close();
    this.clearWSServerMirror();
  }

  emit<Event extends keyof DebugerRouterDriverEvents>(
    event: Event,
    payload: DebugerRouterDriverEvents[Event],
  ): void {
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
    if (this.hiddenUsbClientIds.has(id)) {
      return;
    }
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

  getAllWebsocketAppClients(): MultiplexerWebSocketClient[] {
    return Array.from(this.websocketAppClients.values());
  }

  getAllAppClients(): Client[] {
    const clients: Client[] = [...Array.from(this.usbClients.values())];
    if (this.shouldExposeWebSocketState()) {
      this.getAllWebsocketAppClients().forEach((client) => {
        clients.push(client);
      });
    }
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
      this.clearWebSocketClientMirrors();
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

  private shouldExposeWebSocketState(): boolean {
    return Boolean(
      this.enableWebSocket &&
        (this.webSocketServerStarted || this.startingWSServer),
    );
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
      void this.restoreDesiredState().catch((error: Error) => {
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
    this.hiddenUsbClientIds.clear();
    this.clearWebSocketClientMirrors();
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
    if (this.shouldExposeWebSocketState() && snapshot.websocketAppClients) {
      this.syncWebSocketAppSnapshots(snapshot.websocketAppClients);
    }
    if (this.shouldExposeWebSocketState() && snapshot.websocketWebClients) {
      this.syncWebSocketWebSnapshots(snapshot.websocketWebClients);
    }
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
        if (!this.isDeviceSnapshotEnabled(event.data)) {
          break;
        }
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
        if (!this.isClientSnapshotEnabled(event.data)) {
          this.hiddenUsbClientIds.add(event.data.id);
          break;
        }
        this.hiddenUsbClientIds.delete(event.data.id);
        const client = MultiplexerUsbClient.fromSnapshot(
          event.data,
          this.daemonClient,
        );
        this.regiserUsbClient(client);
        break;
      }
      case "client-disconnected":
        this.hiddenUsbClientIds.delete(event.data.id);
        this.unregisterUsbClientInternal(event.data.id, true);
        break;
      case "usb-client-message":
        this.handleUsbMessage(event.data.id, event.data.message);
        break;
      case "ws-client-message":
        if (!this.shouldExposeWebSocketState()) {
          break;
        }
        this.emit("ws-client-message", event.data as any);
        break;
      case "ws-web-message":
        if (!this.shouldExposeWebSocketState()) {
          break;
        }
        this.emit("ws-web-message", event.data as any);
        break;
      case "websocket-app-client-connected":
        if (!this.shouldExposeWebSocketState()) {
          break;
        }
        this.upsertWebSocketAppSnapshot(event.data, true);
        break;
      case "websocket-app-client-disconnected":
        if (!this.shouldExposeWebSocketState()) {
          break;
        }
        this.websocketAppClients.delete(event.data.id);
        this.emit("websocket-app-client-disconnected", event.data.id as any);
        this.emit("app-client-disconnected", event.data.id as any);
        break;
      case "websocket-web-client-connected":
        if (!this.shouldExposeWebSocketState()) {
          break;
        }
        this.upsertWebSocketWebSnapshot(event.data, true);
        break;
      case "websocket-web-client-disconnected":
        if (!this.shouldExposeWebSocketState()) {
          break;
        }
        this.websocketWebClients.delete(event.data.id);
        this.emit("websocket-web-client-disconnected", event.data.id as any);
        break;
    }
  }

  private syncDeviceSnapshots(snapshots: DeviceSnapshot[]): void {
    const enabledSnapshots = snapshots.filter((snapshot) =>
      this.isDeviceSnapshotEnabled(snapshot),
    );
    const activeSerials = new Set(
      enabledSnapshots.map((snapshot) => snapshot.serial),
    );
    this.upsertDeviceSnapshots(enabledSnapshots);

    for (const serial of Array.from(this.devices.keys())) {
      if (!activeSerials.has(serial)) {
        this.unregisterDeviceInternal(serial, false);
      }
    }
  }

  private applyLegacyOwnershipChange(status: "attached" | "unattached"): void {
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
    const enabledSnapshots = this.filterClientSnapshots(snapshots);
    const activeIds = new Set(enabledSnapshots.map((snapshot) => snapshot.id));
    const snapshotIds = new Set(snapshots.map((snapshot) => snapshot.id));
    for (const id of Array.from(this.hiddenUsbClientIds)) {
      if (!snapshotIds.has(id)) {
        this.hiddenUsbClientIds.delete(id);
      }
    }
    this.upsertClientSnapshots(enabledSnapshots);

    for (const id of Array.from(this.usbClients.keys())) {
      if (!activeIds.has(id)) {
        this.unregisterUsbClientInternal(id, true);
      }
    }
  }

  private syncWebSocketAppSnapshots(
    snapshots: WebSocketClientSnapshot[],
  ): void {
    const activeIds = new Set(snapshots.map((snapshot) => snapshot.id));
    for (const snapshot of snapshots) {
      this.upsertWebSocketAppSnapshot(snapshot, true);
    }
    for (const id of Array.from(this.websocketAppClients.keys())) {
      if (activeIds.has(id)) {
        continue;
      }
      this.websocketAppClients.delete(id);
      this.emit("websocket-app-client-disconnected", id as any);
      this.emit("app-client-disconnected", id as any);
    }
  }

  private clearWebSocketClientMirrors(): void {
    for (const id of Array.from(this.websocketAppClients.keys())) {
      this.websocketAppClients.delete(id);
      this.emit("websocket-app-client-disconnected", id as any);
      this.emit("app-client-disconnected", id as any);
    }
    for (const id of Array.from(this.websocketWebClients.keys())) {
      this.websocketWebClients.delete(id);
      this.emit("websocket-web-client-disconnected", id as any);
    }
  }

  private syncWebSocketWebSnapshots(
    snapshots: WebSocketClientSnapshot[],
  ): void {
    const activeIds = new Set(snapshots.map((snapshot) => snapshot.id));
    for (const snapshot of snapshots) {
      this.upsertWebSocketWebSnapshot(snapshot, true);
    }
    for (const id of Array.from(this.websocketWebClients.keys())) {
      if (activeIds.has(id)) {
        continue;
      }
      this.websocketWebClients.delete(id);
      this.emit("websocket-web-client-disconnected", id as any);
    }
  }

  private upsertWebSocketAppSnapshot(
    snapshot: WebSocketClientSnapshot,
    emitConnected: boolean,
  ): MultiplexerWebSocketClient {
    const existing = this.websocketAppClients.get(snapshot.id);
    if (existing) {
      existing.updateFromSnapshot(snapshot);
      return existing;
    }
    const client = MultiplexerWebSocketClient.fromSnapshot(
      snapshot,
      this.daemonClient,
    );
    this.websocketAppClients.set(snapshot.id, client);
    if (emitConnected) {
      this.emit("websocket-app-client-connected", client as any);
      this.emit("app-client-connected", client as any);
    }
    return client;
  }

  private upsertWebSocketWebSnapshot(
    snapshot: WebSocketClientSnapshot,
    emitConnected: boolean,
  ): MultiplexerWebSocketClient {
    const existing = this.websocketWebClients.get(snapshot.id);
    if (existing) {
      existing.updateFromSnapshot(snapshot);
      return existing;
    }
    const client = MultiplexerWebSocketClient.fromSnapshot(
      snapshot,
      this.daemonClient,
      () => this.sendClientListToWebSocketClient(snapshot.id),
    );
    this.websocketWebClients.set(snapshot.id, client);
    if (emitConnected) {
      this.emit("websocket-web-client-connected", client as any);
    }
    return client;
  }

  private sendClientListToWebSocketClient(webClientId: number): void {
    const webClient = this.websocketWebClients.get(webClientId);
    if (!webClient || webClient.type() !== "Driver") {
      return;
    }

    const data: Array<{
      id: number;
      type: string;
      info: Record<string, unknown>;
    }> = [];
    for (const client of this.websocketAppClients.values()) {
      data.push({
        id: client.clientId(),
        type: client.info.type,
        info: {
          ...(client.info.raw_info as Record<string, unknown>),
          network: "WiFi",
        },
      });
    }
    for (const client of this.usbClients.values()) {
      data.push({
        id: client.clientId(),
        type: "runtime",
        info: {
          ...(client.info.query.raw_info as Record<string, unknown>),
          deviceName: client.info.query.device,
          osType: client.info.query.os,
          deviceModel: client.info.query.device_model,
          network: "USB",
        },
      });
    }

    webClient.sendMessage(
      JSON.stringify({
        event: "ClientList",
        data,
      }),
    );
  }

  private upsertDeviceSnapshots(
    snapshots: DeviceSnapshot[],
  ): MultiplexerDevice[] {
    return snapshots
      .filter((snapshot) => this.isDeviceSnapshotEnabled(snapshot))
      .map((snapshot) => this.upsertDeviceSnapshot(snapshot));
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
    return this.filterClientSnapshots(snapshots).map((snapshot) =>
      this.upsertClientSnapshot(snapshot),
    );
  }

  private filterClientSnapshots(
    snapshots: Snapshot["clients"],
  ): ClientSnapshot[] {
    const enabledSnapshots: ClientSnapshot[] = [];
    for (const snapshot of snapshots) {
      if (this.isClientSnapshotEnabled(snapshot)) {
        this.hiddenUsbClientIds.delete(snapshot.id);
        enabledSnapshots.push(snapshot);
      } else {
        this.hiddenUsbClientIds.add(snapshot.id);
      }
    }
    return enabledSnapshots;
  }

  private isDeviceSnapshotEnabled(snapshot: DeviceSnapshot): boolean {
    switch (snapshot.os) {
      case DeviceOS.Android:
        return this.enableAndroid;
      case DeviceOS.iOS:
        return this.enableIOS;
      case DeviceOS.Harmony:
        return this.enableHarmony;
      case DeviceOS.Mac:
      case DeviceOS.Windows:
      case DeviceOS.Linux:
        return this.enableDesktop;
      case DeviceOS.Network:
        return this.enableNetworkDevice;
      default:
        return true;
    }
  }

  private isClientSnapshotEnabled(snapshot: ClientSnapshot): boolean {
    return this.devices.has(snapshot.query.device_id);
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
  useConnectorCapabilities: boolean,
): PhysicalConnectorOption {
  const connectionTrace = option.connectionTrace
    ? {
        enabled: option.connectionTrace.enabled,
        bufferSize: option.connectionTrace.bufferSize,
        output:
          typeof option.connectionTrace?.output === "string"
            ? path.resolve(option.connectionTrace?.output)
            : undefined,
      }
    : undefined;

  if (
    option.connectionTrace?.output !== undefined &&
    typeof option.connectionTrace.output !== "string"
  ) {
    defaultLogger.warn(
      "Multiplexer connectionTrace.output only supports a serializable string path; WritableStream output is ignored.",
    );
  }

  return {
    manualConnect: useConnectorCapabilities
      ? option.manualConnect ?? false
      : false,
    enableWebSocket: useConnectorCapabilities
      ? option.enableWebSocket ?? false
      : true,
    enableAndroid: useConnectorCapabilities
      ? option.enableAndroid ?? true
      : true,
    enableIOS: useConnectorCapabilities ? option.enableIOS ?? true : true,
    enableHarmony: useConnectorCapabilities
      ? option.enableHarmony ?? true
      : true,
    enableDesktop: useConnectorCapabilities
      ? option.enableDesktop ?? false
      : true,
    enableNetworkDevice: useConnectorCapabilities
      ? option.enableNetworkDevice ?? false
      : option.networkDeviceOpt !== undefined,
    adbHostPort: option.adbHostPort,
    hdcHostPort: option.hdcHostPort,
    usbConnectOpt: option.usbConnectOpt,
    networkDeviceOpt: option.networkDeviceOpt,
    reportService: null,
    connectionTrace,
  };
}
