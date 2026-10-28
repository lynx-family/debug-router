// Copyright 2024 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

import { EventEmitter } from "events";
import {
  DriverReportService,
  initDriverReportService,
} from "../report/interface/DriverReportService";
import path from "path";
import { DeviceManager } from "../device/DeviceManager";
import type { PhysicalConnectorOption } from "../physical/PhysicalConnector";
import type {
  ConnectionTraceNode,
  ConnectionTraceOptions,
} from "../trace/ConnectionTraceRecorder";
import { defaultLogger } from "../utils/logger";
import { driver_dir } from "../utils/file_lock";
import { DebugerRouterDriverEvents, DeviceOS } from "../utils/type";
import { Client } from "./Client";
import { DriverClient } from "./DriverClient";
import {
  DefaultMultiOpenCallback,
  MultiOpenCallback,
  MultiOpenStatus,
} from "./MultiOpenCallBack";
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

/** Legacy compatibility facade; the daemon owns the actual WebSocket server. */
class WebSocketServerCompat {
  constructor(public wssPath: string) {}

  /** Compatibility no-op: callers cannot close the shared daemon's server. */
  close(): void {
    defaultLogger.warn(
      "wss.close is a compatibility no-op; the WebSocket server is managed by the multiplexer daemon.",
    );
  }
}

/**
 * Configuration for the public Connector facade, including inherited
 * PhysicalConnectorOption fields. The constructor also accepts no options.
 *
 * Required options:
 * No top-level option is required. When an optional object is supplied,
 * usbConnectOpt.retryTime and networkDeviceOpt.ip / networkDeviceOpt.port
 * are required within their respective objects.
 *
 * Optional options:
 * | Option                       | Description                                                        |
 * | ---------------------------- | ------------------------------------------------------------------ |
 * | manualConnect                | Skip automatic connectDevices() on construction; defaults to false. |
 * | reportService                | Caller-supplied reporting service; null/omitted disables this facade. |
 * | enableAndroid                | Expose Android devices and clients; defaults to true.               |
 * | enableIOS                    | Expose iOS devices and clients; defaults to true; macOS/Windows only. |
 * | enableHarmony                | Expose Harmony devices and clients; defaults to true.               |
 * | enableDesktop                | Expose desktop devices and clients; defaults to false.              |
 * | enableNetworkDevice          | Expose configured network devices; defaults to false.               |
 * | enableWebSocket              | Allow this facade to start/use the shared WebSocket service; false. |
 * | adbHostPort                  | ADB server endpoint; optional host and port use transport defaults. |
 * | hdcHostPort                  | HDC server endpoint; optional host and port use transport defaults. |
 * | usbConnectOpt                | USB connection settings; retryTime is in ms, default/minimum 3000.  |
 * | networkDeviceOpt             | Network target: required IP and optional debugger client ports.     |
 * | websocketOption              | Optional shared WebSocket settings; see nested fields below.        |
 * | websocketOption.port         | Legacy compatibility field; ignored, port selection starts at 19783. |
 * | websocketOption.roomId       | Optional room identifier returned in WebSocket RoomJoined.          |
 * | connectionTrace              | Optional daemon-owned tracing: enabled, output, and bufferSize.     |
 * | connectionTrace.enabled      | Enable tracing; omission follows the trace output/environment rules. |
 * | connectionTrace.output       | Output file path; WritableStream cannot cross IPC and is ignored.   |
 * | connectionTrace.bufferSize   | Maximum buffered trace entries; defaults to 2000.                   |
 * | multiplexerDaemonIdleTimeout | Idle shutdown delay in ms; defaults to 600000; negative disables it. |
 * | multiplexerStartupTimeout    | Daemon readiness timeout in ms; defaults to 5000.                   |
 * | multiplexerRpcTimeout        | Default RPC response timeout in ms; defaults to 5000.               |
 *
 * Internal debug/test overrides (all optional; normal callers should omit):
 * | Option                     | Description                                                          |
 * | -------------------------- | -------------------------------------------------------------------- |
 * | enableDebugMode            | Replace the shared daemon on ensure and stop it on close; false.      |
 * | multiplexerRootDir         | Data root; defaults to ~/.DebugRouterConnector.                       |
 * | multiplexerDataDir         | Full data directory; overrides rootDir/multiplexer.                   |
 * | multiplexerDaemonEntry     | Alternate daemon entry JS file; defaults to the bundled entry.        |
 * | multiplexerLegacyDriverDir | Legacy ownership directory; defaults to the existing driver_dir.      |
 * | traceRecorder              | Inherited in-process PhysicalConnector injection; ignored by facade. |
 *
 * Capability flags normally filter this facade's mirrors and events. Transport,
 * WebSocket, trace, and idle options configure a newly spawned shared daemon;
 * later facades do not reconfigure an already running daemon.
 *
 * About reportService:
 * The service stays in the Connector process and is not passed to the daemon.
 * Each facade initializes its supplied service with manualConnect and retains
 * that instance. Initialization errors propagate to the constructor caller.
 * Reconnecting a facade does not initialize the service again; constructing
 * another facade does, even when the same service object is supplied.
 * The daemon forwards each report to one connected reporting-enabled facade.
 * Null or omitted reportService disables reporting only for this facade.
 *
 * About enableDebugMode:
 * Debug/test-only escape hatch for daemon-global configuration.
 *
 * On every daemon access that needs a new control connection, stop the daemon
 * currently using the same multiplexerDataDir and spawn a new daemon from this
 * Connector's daemon entry and daemon-global options. The replacement
 * disconnects every Connector sharing that daemon. Both normal startup and
 * replacement preserve this Connector's manualConnect and capability options;
 * replacement also clears capabilities accumulated from earlier facades. Closing this
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
  reportService?: DriverReportService | null;
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
  private readonly events = new EventEmitter();
  readonly devices: Map<string, MultiplexerDevice> = new Map();
  readonly usbClients: Map<number, MultiplexerUsbClient> = new Map();
  readonly enableWebSocket;
  private selectedClient: MultiplexerUsbClient | undefined;
  private enableAndroid: boolean;
  private enableIOS: boolean;
  private enableHarmony: boolean;
  private enableDesktop: boolean;
  private readonly enableNetworkDevice: boolean;
  private readonly driverClient: DriverClient;
  private multiOpenCallback: MultiOpenCallback = new DefaultMultiOpenCallback();
  private closed: boolean = false;
  wssPort: number = DEFAULT_DEV_SERVE_PORT;
  wssHost: string | undefined;
  roomId: string | undefined;
  wss: WebSocketServerCompat | null = null;
  private readonly reportService: DriverReportService | null;
  private readonly daemonClient: MultiplexerDaemonClient;
  private readonly enableDebugMode: boolean;
  private readonly websocketAppClients: Map<
    number,
    MultiplexerWebSocketClient
  > = new Map();
  private readonly websocketWebClients: Map<
    number,
    MultiplexerWebSocketClient
  > = new Map();
  private multiOpenStatus = MultiOpenStatus.unInit;
  // Keep caller intent across daemon disconnects; these flags do not describe current connectivity.
  private desiredWSServerStarted = false;
  private desiredDeviceDiscoveryStarted = false;
  private desiredWatchAllClientsStarted = false;
  private desiredRecoveryTimer: NodeJS.Timeout | null = null;
  private unsubscribeDaemonEvents: (() => void) | undefined;
  private unsubscribeDaemonConnectionEvent: (() => void) | undefined;

  constructor(
    /**
     * Each facade advertises its platform flags and transport options whenever
     * it registers. The shared daemon adds enabled capabilities and new endpoints;
     * false flags and facade disconnection do not remove existing listeners.
     * Each facade still filters the devices and clients it exposes.
     *
     * WebSocket room settings, tracing, idle timeout and legacyDriverDir remain
     * daemon-global startup settings. enableDebugMode remains an explicit
     * debug/test option that replaces the daemon on ensure.
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
    // Reporting implementations can contain circular SDK state and never cross
    // the daemon boundary, including through configuration logging.
    const msg = "DebugRouterOption:" + JSON.stringify(option);
    defaultLogger.debug(msg);

    this.reportService = initDriverReportService(
      option.reportService,
      option.manualConnect,
    );

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

    // Configure daemon discovery and startup; connect lazily on the first RPC.
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
      enableWebSocket: this.enableWebSocket,
      websocketOption: option.websocketOption,
      connectionTrace: createDaemonConnectionTraceOption(option),
      physicalConnectorOption: createDaemonPhysicalConnectorOption(option),
    });

    this.daemonClient = new MultiplexerDaemonClient({
      daemonManager,
      controlEndpoint: paths.controlEndpoint,
      rpcTimeout: option.multiplexerRpcTimeout,
      reportServiceEnabled: this.reportService !== null,
      connectorFacadeOption: {
        ...createDaemonPhysicalConnectorOption(option),
        enableWebSocket: this.enableWebSocket,
      },
    });
    // Apply daemon snapshots/messages to local mirrors; retain cleanup for close().
    this.unsubscribeDaemonEvents = this.daemonClient.subscribe((event) =>
      this.applyHostEvent(event),
    );
    // On disconnect, clear stale mirrors and schedule reconnection/state recovery.
    this.unsubscribeDaemonConnectionEvent = this.daemonClient.subscribeConnectionEvent(
      (event) => {
        if (event.state === "disconnected") {
          this.handleDaemonDisconnected();
          return;
        }
      },
    );

    // Legacy sender identity only; this is not a daemon-registered runtime client.
    this.driverClient = new DriverClient(1);

    // Unless manual, start discovery asynchronously and retry through recovery on failure.
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
   * @deprecated Client IDs are allocated by the daemon.
   * Retained for compatibility; returns -1 without allocating an ID.
   */
  createClientId(): number {
    defaultLogger.warn(
      "createClientId is unsupported on DebugRouterConnector; client IDs are allocated by the daemon. Returning -1.",
    );
    return -1;
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

  async watchNetworkDeviceAtIp(options: {
    ip: string;
    port?: number[];
  }): Promise<void> {
    await this.daemonClient.call("watchNetworkDeviceAtIp", options);
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

  /** TODO: Query daemon-owned connection traces; currently returns an empty list. */
  getConnectionTrace(_limit?: number): ConnectionTraceNode[] {
    return [];
  }

  /** TODO: Subscribe to daemon-owned connection traces; currently returns a no-op unsubscribe. */
  onConnectionTrace(
    _listener: (node: ConnectionTraceNode) => void,
  ): () => void {
    return () => {};
  }

  async close(): Promise<void> {
    // Ignore repeated closes and prevent any further recovery attempts.
    if (this.closed) {
      return;
    }

    this.closed = true;
    // Detach daemon listeners before disconnecting so close cannot trigger recovery.
    this.unsubscribeDaemonEvents?.();
    this.unsubscribeDaemonEvents = undefined;
    this.unsubscribeDaemonConnectionEvent?.();
    this.unsubscribeDaemonConnectionEvent = undefined;
    this.clearDesiredRecoveryTimer();
    // Debug mode explicitly stops the shared daemon and removes its artifacts.
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
    // Normally close only this control connection; the daemon owns shared resources.
    await this.daemonClient.close();
    this.wss = null;
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

  unregisterDevice(serial: string, force: boolean = false): void {
    if (!force) {
      defaultLogger.warn(
        "unregisterDevice is ignored unless force is true; device ownership is shared by the daemon.",
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
   * With force enabled, removes the local USB client mirror.
   * External callers should not invoke this blindly to close a runtime client;
   * use client.close() for that purpose.
   */
  unregiserUsbClient(id: number, force: boolean = false): void {
    if (!force) {
      defaultLogger.warn(
        "unregiserUsbClient is ignored unless force is true; client ownership is shared by the daemon.",
      );
      return;
    }
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

  /**
   * @deprecated WebSocket messages are routed by the daemon.
   * Retained for compatibility; logs a warning without forwarding the message.
   */
  handleWsMessage(_id: number, _message: string): void {
    defaultLogger.warn(
      "handleWsMessage is ignored on DebugRouterConnector; WebSocket messages are routed by the daemon.",
    );
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
    if (!this.enableWebSocket || this.closed) {
      return;
    }
    this.desiredWSServerStarted = true;
    try {
      const info = await this.daemonClient.call("startWSServer", {});
      if (!this.closed) {
        this.applyWebSocketServerInfo(info);
      }
    } catch (error) {
      this.clearWebSocketClientMirrors();
      this.scheduleDesiredRecovery();
      throw error;
    }
  }

  getDriverClient(): DriverClient {
    return this.driverClient;
  }

  getAllWebsocketAppClients(): MultiplexerWebSocketClient[] {
    return Array.from(this.websocketAppClients.values());
  }

  private applyWebSocketServerInfo(info: WebSocketServerInfo): void {
    this.wssPort = info.port;
    this.wssHost = info.host;
    this.roomId = info.roomId;
    this.wss = new WebSocketServerCompat(
      `ws://${info.host}/mdevices/page/android`,
    );
  }

  private shouldExposeWebSocketState(): boolean {
    // Host may send the initial snapshot before startWSServer returns and sets wss.
    return Boolean(
      !this.closed &&
        this.enableWebSocket &&
        (this.wss !== null || this.desiredWSServerStarted),
    );
  }

  private handleDaemonDisconnected(): void {
    this.clearDaemonMirrors();
    this.scheduleDesiredRecovery();
  }

  private clearDesiredRecoveryTimer(): void {
    if (this.desiredRecoveryTimer) {
      clearTimeout(this.desiredRecoveryTimer);
      this.desiredRecoveryTimer = null;
    }
  }

  private scheduleDesiredRecovery(): void {
    // Stop recovery after close and reuse any already scheduled retry.
    if (this.closed) {
      return;
    }
    if (this.desiredRecoveryTimer) {
      return;
    }

    // Reconnect after a short delay and restore previously requested discovery, watchers, and WebSocket startup.
    this.desiredRecoveryTimer = setTimeout(() => {
      // Release the timer before recovery so a failed attempt can schedule another retry.
      this.desiredRecoveryTimer = null;
      void this.restoreDesiredState().catch((error: Error) => {
        defaultLogger.warn(
          `Failed to restore desired multiplexer state after daemon reconnect: ${error.message}`,
        );
        // Keep retrying at the same interval until recovery succeeds or the connector closes.
        this.scheduleDesiredRecovery();
      });
    }, DESIRED_RECOVERY_RETRY_DELAY_MS);
  }

  private async restoreDesiredState(): Promise<void> {
    await this.daemonClient.connect();

    // Restore discovery before watchers so device mirrors exist when clients arrive.
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
      await this.startWSServer();
    }
  }

  private clearDaemonMirrors(): void {
    this.wss = null;

    // Notify client disconnections before removing their parent devices; leave shared resources to Host.
    for (const id of Array.from(this.usbClients.keys())) {
      this.unregisterUsbClientInternal(id);
    }
    this.clearWebSocketClientMirrors();
    for (const serial of Array.from(this.devices.keys())) {
      this.unregisterDeviceInternal(serial, false);
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

  applyHostEvent(event: ControlEvent): void {
    // Translate daemon events into local mirrors and the existing Connector event API.
    switch (event.event) {
      case "connector-error":
        this.emit("connector-error", event.data);
        break;
      case "report":
        this.reportService?.report(
          event.data.eventName,
          event.data.metrics,
          event.data.categories,
        );
        break;
      case "snapshot":
        // Reconcile device/client mirrors, including clients removed from the snapshot.
        this.applySnapshot(event.data);
        break;
      case "legacy-ownership-changed":
        // Update legacy multi-open status and clear the selection when ownership is lost.
        this.applyLegacyOwnershipChange(event.data.status);
        break;
      case "client-message":
        // USB runtime messages use the existing USB client dispatch path.
        if (event.data.source === "usb-runtime") {
          this.handleUsbMessage(event.data.id, event.data.message);
          break;
        }
        // Expose shared WebSocket messages only when this facade has requested startup.
        if (!this.shouldExposeWebSocketState()) {
          break;
        }
        // Keep app runtime messages separate from WebSocket Driver frontend messages.
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

  applySnapshot(snapshot: Snapshot): void {
    // Add devices before clients, then remove stale devices after client disconnection events.
    const activeDeviceSerials = this.upsertDeviceSnapshotState(
      snapshot.devices,
    );
    this.syncClientSnapshots(snapshot.clients);
    if (this.shouldExposeWebSocketState() && snapshot.websocketAppClients) {
      this.syncWebSocketSnapshots(snapshot.websocketAppClients, "app");
    }
    if (this.shouldExposeWebSocketState() && snapshot.websocketWebClients) {
      this.syncWebSocketSnapshots(snapshot.websocketWebClients, "web");
    }
    this.removeStaleDevices(activeDeviceSerials);
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

  private syncWebSocketSnapshots(
    snapshots: WebSocketClientSnapshot[],
    target: "app" | "web",
  ): void {
    // App and Driver client IDs may overlap, so reconcile each collection independently.
    const clients =
      target === "app" ? this.websocketAppClients : this.websocketWebClients;
    const activeIds = new Set(snapshots.map((snapshot) => snapshot.id));
    for (const snapshot of snapshots) {
      this.upsertWebSocketSnapshot(snapshot, target);
    }
    for (const id of Array.from(clients.keys())) {
      if (activeIds.has(id)) {
        continue;
      }
      clients.delete(id);
      this.emit(`websocket-${target}-client-disconnected`, id as any);
      if (target === "app") {
        this.emit("app-client-disconnected", id as any);
      }
    }
  }

  private upsertWebSocketSnapshot(
    snapshot: WebSocketClientSnapshot,
    target: "app" | "web",
  ): MultiplexerWebSocketClient {
    const clients =
      target === "app" ? this.websocketAppClients : this.websocketWebClients;
    const existing = clients.get(snapshot.id);
    if (existing) {
      // Preserve the proxy and its listeners; repeated snapshots must not emit another connection event.
      return existing;
    }
    const client = MultiplexerWebSocketClient.fromSnapshot(
      snapshot,
      this.daemonClient,
    );
    clients.set(snapshot.id, client);
    this.emit(`websocket-${target}-client-connected`, client as any);
    // Only app runtimes also participate in the unified USB/WiFi app-client events.
    if (target === "app") {
      this.emit("app-client-connected", client as any);
    }
    return client;
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

  private unregisterDeviceInternal(serial: string, force: boolean): void {
    const device = this.devices.get(serial);
    if (!device) {
      defaultLogger.debug(
        "unregisterDevice warning: no existed device:" + serial,
      );
      return;
    }

    defaultLogger.debug("unregisterDevice:" + serial);
    this.devices.delete(serial);
    if (force) {
      device.disconnect();
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
): PhysicalConnectorOption {
  return {
    manualConnect: option.manualConnect ?? false,
    enableAndroid: option.enableAndroid ?? true,
    enableIOS: option.enableIOS ?? true,
    enableHarmony: option.enableHarmony ?? true,
    enableDesktop: option.enableDesktop ?? false,
    enableNetworkDevice: option.enableNetworkDevice ?? false,
    adbHostPort: option.adbHostPort,
    hdcHostPort: option.hdcHostPort,
    usbConnectOpt: option.usbConnectOpt,
    networkDeviceOpt: option.networkDeviceOpt,
  };
}

function createDaemonConnectionTraceOption(
  option: DebugRouterConnectorOption,
): ConnectionTraceOptions | undefined {
  // Pass a serializable absolute path because the daemon runs in a separate process and may have a different cwd.
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
