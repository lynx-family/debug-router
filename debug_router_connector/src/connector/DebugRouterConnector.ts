// Copyright 2024 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

import { EventEmitter } from "events";
import path from "path";
import { DeviceManager } from "../device/DeviceManager";
import type { PhysicalConnectorOption } from "../physical/PhysicalConnector";
import type { ConnectionTraceOptions } from "../trace/ConnectionTraceRecorder";
import { defaultLogger } from "../utils/logger";
import { driver_dir } from "../utils/file_lock";
import { DebugerRouterDriverEvents, DeviceOS } from "../utils/type";
import { Client } from "./Client";
import { DriverClient } from "./DriverClient";
import { MultiOpenCallback, MultiOpenStatus } from "./MultiOpenCallBack";
import {
  ControlEvent,
  MULTIPLEXER_PROTOCOL_VERSION,
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
const DESIRED_RECOVERY_RETRY_DELAY_MS = 100;

type WebSocketServerCompat = {
  wssPath: string;
};

/**
 * About enableDebugMode:
 * Debug/test-only escape hatch for daemon-global configuration.
 *
 * On every daemon access that needs a new control connection, stop the daemon
 * currently using the same multiplexerDataDir and spawn a new daemon from this
 * Connector's daemon entry and daemon-global options. The replacement
 * disconnects every Connector sharing that daemon. Unlike normal shared daemon
 * startup, the replacement uses this Connector's manualConnect and capability
 * options exactly, so disabled-capability scenarios can be tested. Closing this
 * Connector force-stops the daemon and removes its endpoint/lock artifacts
 * instead of waiting for the daemon idle timeout. Close never starts or
 * reconnects a daemon, but it still cleans up a daemon and artifacts already
 * present in the selected multiplexerDataDir.
 *
 * For deterministic tests, prefer:
 *   manualConnect: true,
 *   enableDebugMode: true,
 * followed by `await connector.connectDevices()`.
 */

export type DebugRouterConnectorOption = PhysicalConnectorOption & {
  enableWebSocket?: boolean;
  connectionTrace?: ConnectionTraceOptions;
  enableDebugMode?: boolean;
  multiplexerDaemonIdleTimeout?: number;
  multiplexerStartupTimeout?: number;
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
  wssPort: number = DEFAULT_DEV_SERVE_PORT;
  wssHost: string | undefined;
  roomId: string | undefined;
  wss: WebSocketServerCompat | null = null;

  private readonly events = new EventEmitter();
  private readonly daemonClient: MultiplexerDaemonClient;
  private readonly driverClient: DriverClient;
  private enableAndroid: boolean;
  private enableIOS: boolean;
  private readonly enableHarmony: boolean;
  private enableDesktop: boolean;
  private readonly enableNetworkDevice: boolean;
  private readonly enableDebugMode: boolean;
  private selectedClient: MultiplexerUsbClient | undefined;
  private readonly websocketAppClients: Map<
    number,
    MultiplexerWebSocketClient
  > = new Map();
  private readonly websocketWebClients: Map<
    number,
    MultiplexerWebSocketClient
  > = new Map();
  private nextClientId = 0;
  private multiOpenCallback: MultiOpenCallback | undefined;
  private multiOpenStatus = MultiOpenStatus.unInit;
  private closed = false;
  private desiredWSServerStarted = false;
  private startingWSServer: Promise<void> | null = null;
  private desiredDeviceDiscoveryStarted = false;
  private desiredWatchAllClientsStarted = false;
  private desiredRecoveryTimer: NodeJS.Timeout | null = null;
  private unsubscribeDaemonEvents: (() => void) | undefined;
  private unsubscribeDaemonConnectionEvent: (() => void) | undefined;

  constructor(
    /**
     * Connector capability options are normally instance-local. The shared
     * daemon keeps the generally available capabilities enabled, while
     * each Connector filters the devices, clients, snapshots, and events it
     * exposes. enableDebugMode is the debug/test exception: its replacement
     * daemon receives this Connector's capability and manualConnect option
     * values exactly.
     *
     * Options without merge semantics (for example websocketOption,
     * adbHostPort, hdcHostPort, networkDeviceOpt, retry/trace output, daemon
     * idle/stale timeouts, and legacyDriverDir) remain daemon-global. A healthy
     * daemon keeps its existing values; use enableDebugMode only when a
     * debug/test scenario intentionally needs this Connector's values to win.
     */
    option: DebugRouterConnectorOption = {
      manualConnect: false,
      enableDebugMode: false,
      enableWebSocket: false, // deprecated
      enableAndroid: true,
      enableIOS: true,
      enableHarmony: true,
      enableDesktop: false,
      enableNetworkDevice: false,
      websocketOption: {},
    },
  ) {
    const msg = "DebugRouterOption:" + JSON.stringify(option);
    defaultLogger.debug(msg);

    this.enableWebSocket = option.enableWebSocket ?? false;
    this.enableAndroid = option.enableAndroid ?? true;
    this.enableIOS = option.enableIOS ?? true;
    this.enableHarmony = option.enableHarmony ?? true;
    this.enableDesktop = option.enableDesktop ?? false;
    this.enableNetworkDevice = option.enableNetworkDevice ?? false;
    this.enableDebugMode = option.enableDebugMode ?? false;
    this.roomId = option.websocketOption?.roomId;
    if (this.enableDebugMode) {
      defaultLogger.warn(
        "enableDebugMode is enabled; every daemon access that needs a new control connection will replace the daemon shared by this multiplexerDataDir using this Connector's local daemon entry and exact capability options, and closing this Connector will force-stop that daemon and clean its artifacts.",
      );
    }

    const paths = createMultiplexerPaths({
      rootDir: option.multiplexerRootDir,
      dataDir: option.multiplexerDataDir,
    });
    const discovery = new MultiplexerDiscovery({
      controlEndpoint: paths.controlEndpoint,
      localProtocolVersion: MULTIPLEXER_PROTOCOL_VERSION,
    });
    const daemonManager = new MultiplexerDaemonManager({
      discovery,
      daemonProcessName: paths.daemonProcessName,
      controlEndpoint: paths.controlEndpoint,
      spawnLockPath: paths.spawnLockPath,
      daemonEntry: option.multiplexerDaemonEntry ?? resolveDaemonEntryPath(),
      startupTimeout:
        option.multiplexerStartupTimeout ?? DEFAULT_MULTIPLEXER_STARTUP_TIMEOUT,
      legacyDriverDir: option.multiplexerLegacyDriverDir ?? driver_dir,
      multiplexerDaemonIdleTimeout:
        option.multiplexerDaemonIdleTimeout ??
        DEFAULT_MULTIPLEXER_DAEMON_IDLE_TIMEOUT,
      enableDebugMode: this.enableDebugMode,
      enableWebSocket: this.enableDebugMode ? this.enableWebSocket : true,
      websocketOption: option.websocketOption,
      connectionTrace: createDaemonConnectionTraceOption(option),
      physicalConnectorOption: createDaemonPhysicalConnectorOption(
        {
          ...option,
          enableAndroid: this.enableAndroid,
          enableIOS: this.enableIOS,
          enableHarmony: this.enableHarmony,
          enableDesktop: this.enableDesktop,
          enableNetworkDevice: this.enableNetworkDevice,
        },
        this.enableDebugMode,
      ),
    });

    this.daemonClient = new MultiplexerDaemonClient({
      daemonManager,
      controlEndpoint: paths.controlEndpoint,
      rpcTimeout: option.multiplexerRpcTimeout,
    });
    this.unsubscribeDaemonEvents = this.daemonClient.subscribe((event) =>
      this.applyHostEvent(event),
    );
    this.unsubscribeDaemonConnectionEvent = this.daemonClient.subscribeConnectionEvent(
      (event) => {
        if (event.state === "disconnected") {
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

  /**
   * With force enabled, stops every daemon-owned device watcher and closes
   * every USB/WiFi runtime. This is a daemon-global operation and affects all
   * sharing Connectors.
   */
  async disableAllClients(force: boolean = false): Promise<void> {
    if (!force) {
      defaultLogger.warn(
        "disableAllClients is ignored unless force is true; device and client ownership is shared by the daemon.",
      );
      return;
    }

    this.selectedClient = undefined;
    this.desiredWatchAllClientsStarted = false;
    await this.daemonClient.call("stopAllDeviceClientWatchers", {});
  }

  startWatchAllClients(_force: boolean = true): void {
    this.desiredWatchAllClientsStarted = true;
    void this.daemonClient
      .call("startAllDeviceClientWatchers", {})
      .catch((error: Error) => {
        defaultLogger.warn(
          `Failed to start multiplexer client watchers: ${error.message}`,
        );
        this.scheduleDesiredRecovery();
      });
  }

  /**
   * Allocates IDs only for Connector-local compatibility objects.
   * Real SDK Runtime client IDs are allocated by the daemon.
   */
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
    const snapshots = await this.daemonClient.call("connectDevices", {
      timeout,
      serial,
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
    this.unsubscribeDaemonConnectionEvent?.();
    this.unsubscribeDaemonConnectionEvent = undefined;
    this.clearDesiredRecoveryTimer();
    if (this.enableDebugMode) {
      try {
        defaultLogger.info(
          "Debug-mode Connector is closing; force-stopping the current daemon and cleaning its artifacts.",
        );
        await this.daemonClient.forceStopDaemon();
      } catch (error) {
        defaultLogger.warn(
          `Failed to force-stop daemon while closing debug-mode Connector: ${
            (error as Error).message
          }`,
        );
      }
    }
    await this.daemonClient.close();
    this.wss = null;
  }

  private clearDesiredRecoveryTimer(): void {
    if (this.desiredRecoveryTimer) {
      clearTimeout(this.desiredRecoveryTimer);
      this.desiredRecoveryTimer = null;
    }
  }

  emit<Event extends keyof DebugerRouterDriverEvents>(
    event: Event,
    payload: DebugerRouterDriverEvents[Event],
  ): void {
    // Connection trace recording is handled inside the daemon now.
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

  unregisterDevice(serial: string, disconnect: boolean = false): void {
    if (!disconnect) {
      defaultLogger.warn(
        "unregisterDevice is ignored unless disconnect is true; device ownership is shared by the daemon.",
      );
      return;
    }
    this.unregisterDeviceInternal(serial, true);
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

  /**
   * Cleans up the local mirror after the client has disconnected.
   * External callers should not invoke this blindly to close a runtime client;
   * use client.close() for that purpose.
   */
  unregiserUsbClient(id: number): void {
    this.unregisterUsbClientInternal(id);
  }

  getDevices(
    timeout: number = -1,
    serial: string | null = null,
  ): Promise<MultiplexerDevice[]> {
    return new Promise((resolve) => {
      if (timeout < 0) {
        resolve(this.findDevice(serial));
      } else {
        const deviceCallback = (device: MultiplexerDevice) => {
          if (device.serial === serial) {
            resolve(this.findDevice(serial));
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
      }
    });
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

  getAllUsbClients(): MultiplexerUsbClient[] {
    const clients = new Array();
    this.usbClients.forEach((value, key) => {
      clients.push(value);
    });
    return clients;
  }

  getDeviceUsbClients(
    deviceId: string,
    timeout: number = -1,
    clientName: string | null = null,
  ): Promise<MultiplexerUsbClient[]> {
    return new Promise((resolve) => {
      if (!this.devices.has(deviceId)) {
        defaultLogger.debug("getDeviceUsbClients: has" + deviceId);
        resolve([]);
      }
      if (timeout < 0) {
        let clients = Array.from(this.usbClients.values());
        clients = clients.filter((client) => {
          return client.deviceId() === deviceId;
        });
        resolve(this.findUsbClient(clientName, clients));
      } else {
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
          const targetClients = this.findUsbClient(
            clientName,
            Array.from(this.usbClients.values()),
          );
          if (targetClients.length > 0) {
            resolve(targetClients);
            return;
          }
          this.on("client-connected", clientCallback as any);
        }
        setTimeout(() => {
          this.off("client-connected", clientCallback as any);
          let clients = Array.from(this.usbClients.values());
          clients = clients.filter((client) => {
            return client.deviceId() === deviceId;
          });
          resolve(this.findUsbClient(clientName, clients));
        }, timeout);
      }
    });
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

  handleUsbMessage(id: number, message: string): void {
    const client = this.usbClients.get(id);
    if (!client) {
      return;
    }
    this.emit("usb-client-message", { id, message } as any);
    client.handleMessage(message);
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
      .call("sendMessageWithoutReply", {
        target: "app",
        clientId: id,
        message: JSON.stringify(data),
      })
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

  // send message to web platform
  sendMessageToWeb(message: string): void {
    if (!this.enableWebSocket) {
      defaultLogger.warn("enableWebSocket isn't opened!");
      return;
    }
    if (this.wss === null) {
      defaultLogger.warn("websocket server hasn't started up");
      return;
    }
    void this.daemonClient
      .call("sendMessageWithoutReply", {
        target: "web",
        clientId: -1,
        message,
      })
      .catch((error: Error) => {
        defaultLogger.warn(
          `Failed to send multiplexer message to web: ${error.message}`,
        );
      });
  }

  // send message to app(include apps connected by usb and wifi)
  sendMessageToApp(id: number, message: string): void {
    if (!this.enableWebSocket) {
      defaultLogger.warn("enableWebSocket isn't opened!");
      return;
    }
    if (this.wss === null) {
      defaultLogger.warn("websocket server hasn't started up");
      return;
    }
    void this.daemonClient
      .call("sendMessageWithoutReply", {
        target: "app",
        clientId: id,
        message,
      })
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
    if (this.closed) {
      return Promise.resolve();
    }
    if (this.startingWSServer) {
      return this.startingWSServer;
    }

    this.startingWSServer = this.daemonClient
      .call("startWSServer", {})
      .then((info) => {
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
  }

  private shouldExposeWebSocketState(): boolean {
    return Boolean(
      this.enableWebSocket &&
        (this.wss !== null || this.startingWSServer),
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

    if (this.desiredDeviceDiscoveryStarted) {
      const snapshots = await this.daemonClient.call("connectDevices", {
        timeout: -1,
        serial: null,
      });
      this.upsertDeviceSnapshots(snapshots);
    }

    if (this.desiredWatchAllClientsStarted) {
      await this.daemonClient.call("startAllDeviceClientWatchers", {});
    }

    if (this.desiredWSServerStarted && this.wss === null) {
      await this.ensureWSServerStarted();
    }
  }

  private clearDaemonMirrors(): void {
    this.wss = null;

    for (const id of Array.from(this.usbClients.keys())) {
      this.unregisterUsbClientInternal(id);
    }
    this.clearWebSocketClientMirrors();
    for (const serial of Array.from(this.devices.keys())) {
      this.unregisterDeviceInternal(serial, false);
    }
  }

  getDriverClient(): DriverClient {
    return this.driverClient;
  }

  applySnapshot(snapshot: Snapshot): void {
    const activeDeviceSerials = this.upsertDeviceSnapshotState(
      snapshot.devices,
    );
    this.syncClientSnapshots(snapshot.clients);
    if (this.shouldExposeWebSocketState() && snapshot.websocketAppClients) {
      this.syncWebSocketAppSnapshots(snapshot.websocketAppClients);
    }
    if (this.shouldExposeWebSocketState() && snapshot.websocketWebClients) {
      this.syncWebSocketWebSnapshots(snapshot.websocketWebClients);
    }
    this.removeStaleDevices(activeDeviceSerials);
  }

  applyHostEvent(event: ControlEvent): void {
    switch (event.event) {
      case "snapshot":
        this.applySnapshot(event.data);
        break;
      case "legacy-ownership-changed":
        this.applyLegacyOwnershipChange(event.data.status);
        break;
      case "client-message":
        if (event.data.source === "usb-runtime") {
          this.handleUsbMessage(event.data.id, event.data.message);
          break;
        }
        if (!this.shouldExposeWebSocketState()) {
          break;
        }
        this.emit(
          event.data.source === "websocket-runtime"
            ? "ws-client-message"
            : "ws-web-message",
          {
            id: event.data.id,
            message: event.data.message,
          } as any,
        );
        break;
    }
  }

  private upsertDeviceSnapshotState(snapshots: DeviceSnapshot[]): Set<string> {
    const enabledSnapshots = snapshots.filter((snapshot) =>
      this.isDeviceSnapshotEnabled(snapshot),
    );
    const activeSerials = new Set(
      enabledSnapshots.map((snapshot) => snapshot.serial),
    );
    this.upsertDeviceSnapshots(enabledSnapshots);
    return activeSerials;
  }

  private removeStaleDevices(activeSerials: Set<string>): void {
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
      this.selectedClient = undefined;
    }
    this.multiOpenCallback?.statusChanged?.(nextStatus);
  }

  private syncClientSnapshots(snapshots: Snapshot["clients"]): void {
    const enabledSnapshots = this.filterClientSnapshots(snapshots);
    const activeIds = new Set(enabledSnapshots.map((snapshot) => snapshot.id));
    this.upsertClientSnapshots(enabledSnapshots);

    for (const id of Array.from(this.usbClients.keys())) {
      if (!activeIds.has(id)) {
        this.unregisterUsbClientInternal(id);
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
      return existing;
    }
    const client = MultiplexerWebSocketClient.fromSnapshot(
      snapshot,
      this.daemonClient,
    );
    this.websocketWebClients.set(snapshot.id, client);
    if (emitConnected) {
      this.emit("websocket-web-client-connected", client as any);
    }
    return client;
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
    return snapshots.filter((snapshot) =>
      this.isClientSnapshotEnabled(snapshot),
    );
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
      return existing;
    }

    const client = MultiplexerUsbClient.fromSnapshot(
      snapshot,
      this.daemonClient,
    );
    this.regiserUsbClient(client);
    return client;
  }

  private unregisterDeviceInternal(
    serial: string,
    disconnect: boolean,
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
    this.emit("device-disconnected", device as any);
  }

  private unregisterUsbClientInternal(id: number): void {
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
    this.emit("client-disconnected", id as any);
    this.emit("app-client-disconnected", id as any);
  }
}

function resolveDaemonEntryPath(): string {
  return require.resolve("../multiplexer/daemon/entry");
}

function createDaemonPhysicalConnectorOption(
  option: DebugRouterConnectorOption,
  useConnectorOptionFlags: boolean,
): PhysicalConnectorOption {
  return {
    manualConnect: useConnectorOptionFlags
      ? option.manualConnect ?? false
      : false,
    enableAndroid: useConnectorOptionFlags
      ? option.enableAndroid ?? true
      : true,
    enableIOS: useConnectorOptionFlags ? option.enableIOS ?? true : true,
    enableHarmony: useConnectorOptionFlags
      ? option.enableHarmony ?? true
      : true,
    enableDesktop: useConnectorOptionFlags
      ? option.enableDesktop ?? false
      : true,
    enableNetworkDevice: useConnectorOptionFlags
      ? option.enableNetworkDevice ?? false
      : option.networkDeviceOpt !== undefined,
    adbHostPort: option.adbHostPort,
    hdcHostPort: option.hdcHostPort,
    usbConnectOpt: option.usbConnectOpt,
    networkDeviceOpt: option.networkDeviceOpt,
  };
}

function createDaemonConnectionTraceOption(
  option: DebugRouterConnectorOption,
): ConnectionTraceOptions | undefined {
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

  return connectionTrace;
}
