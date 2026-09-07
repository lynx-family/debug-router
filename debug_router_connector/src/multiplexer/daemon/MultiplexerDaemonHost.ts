// Copyright 2026 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

import { BaseDevice } from "../../device/BaseDevice";
import detectPort from "detect-port";
import { address } from "ip";
import {
  PhysicalConnector,
  PhysicalConnectorOption,
} from "../../physical/PhysicalConnector";
import { getDriverReportService } from "../../report/interface/DriverReportService";
import { UsbClient } from "../../usb/Client";
import { defaultLogger } from "../../utils/logger";
import { WebSocketController } from "../../websocket/WebSocketServer";
import { WebSocketClient } from "../../websocket/WebSocketConnection";
import {
  DebugerRouterDriverEvents,
  PhysicalConnectorEvent,
  ResponseMessageType,
} from "../../utils/type";
import {
  ClientSnapshot,
  ControlEvent,
  ControlRpcParams,
  ControlRpcRequest,
  DeviceSnapshot,
  MultiplexerDebugInfo,
  Snapshot,
  WebSocketClientSnapshot,
  WebSocketServerInfo,
} from "../protocol";
import { MultiplexerControlServer } from "./MultiplexerControlServer";
import {
  LegacyOwnershipChange,
  LegacyOwnershipGuard,
} from "./LegacyOwnershipGuard";
import { MemoizedQueryTable } from "./MemoizedQueryTable";
import { PendingRoute, PendingRouteTable } from "./PendingRouteTable";
import {
  ConnectionTraceOptions,
  ConnectionTraceRecorder,
  createConnectionTraceRecorder,
} from "../../trace/ConnectionTraceRecorder";

const DEFAULT_DEV_SERVE_PORT = 19783;

export type PendingTargetSeed = {
  kind: "control" | "websocket";
  requesterId: number;
  clientId: number;
  resolve?: (value: unknown) => void;
  reject?: (error: Error) => void;
};

export type RoutedMessage = {
  target: PendingRoute;
  clientId: number;
  parsedValue: any;
};

type CustomizedPayload = {
  container: any;
  message: any;
  messageWasString: boolean;
};

export type MultiplexerDaemonHostOption = {
  controlEndpoint: string;
  protocolVersion: number;
  multiplexerDaemonIdleTimeout: number;
  debugInfo?: MultiplexerDebugInfo;
  legacyDriverDir?: string;
  enableWebSocket?: boolean;
  connectionTrace?: ConnectionTraceOptions;
  websocketOption?: {
    port?: number;
    roomId?: string;
  };
  physicalConnectorOption?: PhysicalConnectorOption;
  memoizedNotificationTtlMs?: number;

  // only used for tests or embedding
  physicalConnector?: PhysicalConnector;
  now?: () => number;
};

export class MultiplexerDaemonHost {
  private physicalConnector: PhysicalConnector;
  private readonly manualConnect: boolean;
  private readonly connectionTraceRecorder: ConnectionTraceRecorder | null;
  private readonly option: MultiplexerDaemonHostOption;
  private readonly protocolVersion: number;
  private readonly now: () => number;
  private readonly pendingRoutes: PendingRouteTable;
  private readonly memoizedQueryTable: MemoizedQueryTable;
  private controlServer: MultiplexerControlServer | null = null;
  private webSocketController: WebSocketController | null = null;
  private webSocketServerInfo: WebSocketServerInfo | undefined;
  private readonly clientWatcherStartedDeviceIds = new Set<string>();
  private readonly clientWatcherStartingByDeviceId = new Map<
    string,
    Promise<void>
  >();
  private webSocketServerStarted = false;
  private webSocketServerStarting: Promise<WebSocketServerInfo> | null = null;
  private readonly activeControlIds = new Set<number>();
  private readonly webSocketRequesterControlIds = new Set<number>();
  private readonly activeWebSocketDriverIds = new Set<number>();
  private readonly legacyOwnershipGuard: LegacyOwnershipGuard;
  private idleTimer: NodeJS.Timeout | null = null;
  private idleTimeoutHandler: (() => void | Promise<void>) | undefined;
  private shutdownHandler: (() => void | Promise<void>) | undefined;
  private started = false;
  private shutdownRequested = false;
  private daemonStopReason: string | undefined;

  private get legacyOwnershipAttached(): boolean {
    return this.legacyOwnershipGuard.currentStatus === "attached";
  }

  constructor(option: MultiplexerDaemonHostOption) {
    this.option = option;
    this.manualConnect = option.physicalConnectorOption?.manualConnect ?? false;
    this.protocolVersion = option.protocolVersion;
    this.now = option.now ?? Date.now;
    this.pendingRoutes = new PendingRouteTable({
      now: this.now,
    });
    this.memoizedQueryTable = new MemoizedQueryTable({
      validityPeriodMs: option.memoizedNotificationTtlMs,
      now: this.now,
    });

    this.connectionTraceRecorder = createConnectionTraceRecorder(
      option.connectionTrace,
      process.env.DriverConnectionTracePath,
    );
    this.physicalConnector =
      option.physicalConnector ??
      new PhysicalConnector({
        ...option.physicalConnectorOption,
        traceRecorder: this.connectionTraceRecorder,
      });
    this.legacyOwnershipGuard = new LegacyOwnershipGuard({
      legacyDriverDir: option.legacyDriverDir,
      onStatusChanged: this.handleLegacyOwnershipChanged,
    });
  }

  // Starts the control plane; physical watchers and WebSocket serving remain demand-driven.
  async start(): Promise<void> {
    if (this.started) {
      return;
    }

    this.shutdownRequested = false;
    this.daemonStopReason = undefined;
    this.bindPhysicalConnectorEvents();

    const controlServer = new MultiplexerControlServer({
      host: this,
      controlEndpoint: this.option.controlEndpoint,
      protocolVersion: this.protocolVersion,
      ...(this.option.debugInfo ? { debugInfo: this.option.debugInfo } : {}),
      now: this.now,
    });

    // Publish the instance before awaiting start so stop() can roll back a partial startup.
    this.controlServer = controlServer;

    try {
      await controlServer.start();
      this.started = true;
      const debugInfo = this.createDebugInfo();
      this.connectionTraceRecorder?.recordDaemonStarted({
        pid: process.pid,
        controlEndpoint: controlServer.controlEndpoint,
        protocolVersion: this.protocolVersion,
        ...(debugInfo ? { debugInfo } : {}),
      });
      await this.legacyOwnershipGuard.start();
      this.scheduleIdleTimeoutIfNeeded();
    } catch (error) {
      await this.stop();
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (
      !this.started &&
      !this.controlServer &&
      !this.webSocketController &&
      !this.connectionTraceRecorder
    ) {
      return;
    }

    const stopErrors: unknown[] = [];
    const wasStarted = this.started;
    const daemonStopReason = this.daemonStopReason;
    // Detach lifecycle state first because closing transports may emit callbacks synchronously.
    this.started = false;
    this.shutdownRequested = false;
    this.clearIdleTimeout();
    this.legacyOwnershipGuard.stop();
    this.activeControlIds.clear();
    this.webSocketRequesterControlIds.clear();
    this.activeWebSocketDriverIds.clear();
    this.unbindPhysicalConnectorEvents();

    const webSocketController = this.webSocketController;
    const webSocketServerInfo = this.webSocketServerInfo;
    this.webSocketController = null;
    this.webSocketServerInfo = undefined;
    this.webSocketServerStarted = false;
    this.webSocketServerStarting = null;
    try {
      if (webSocketController) {
        webSocketController.close();
        this.connectionTraceRecorder?.recordWebsocketServerStopped({
          port: webSocketServerInfo?.port,
          host: webSocketServerInfo?.host,
          roomId: webSocketServerInfo?.roomId,
          reason: "daemon_stop",
        });
      }
    } catch (error) {
      stopErrors.push(error);
    }

    const controlServer = this.controlServer;
    this.controlServer = null;
    try {
      await controlServer?.stop();
    } catch (error) {
      stopErrors.push(error);
    }

    try {
      await this.physicalConnector.close();
    } catch (error) {
      stopErrors.push(error);
    } finally {
      this.clearRuntimeState();
    }

    if (wasStarted) {
      this.connectionTraceRecorder?.recordDaemonStopped({
        pid: process.pid,
        reason: daemonStopReason,
      });
    }
    this.daemonStopReason = undefined;

    try {
      await this.connectionTraceRecorder?.close();
    } catch (error) {
      stopErrors.push(error);
    }

    if (stopErrors.length > 0) {
      throw createStopError(stopErrors);
    }
  }

  setIdleTimeoutHandler(handler: () => void | Promise<void>): void {
    this.idleTimeoutHandler = handler;
  }

  setShutdownHandler(handler: () => void | Promise<void>): void {
    this.shutdownHandler = handler;
  }

  isInUse(): boolean {
    return (
      this.activeControlIds.size > 0 || this.activeWebSocketDriverIds.size > 0
    );
  }

  private readonly handleDeviceConnected = (device: BaseDevice): void => {
    if (!this.legacyOwnershipAttached) return;

    if (!this.manualConnect) {
      void this.ensureClientWatcher(device.serial);
    }

    this.sendSnapshot();
  };

  private readonly handleDeviceDisconnected = (device: BaseDevice): void => {
    if (!this.legacyOwnershipAttached) return;

    this.clearClientWatcherStartState(device.serial);

    this.sendSnapshot();
  };

  private readonly handleClientConnected = (client: UsbClient): void => {
    if (!this.legacyOwnershipAttached) {
      return;
    }

    this.connectionTraceRecorder?.recordAppClientConnected(client);
    this.webSocketController?.sendClientList();
    this.sendSnapshot();
  };

  private readonly handleClientDisconnected = (id: number): void => {
    if (!this.legacyOwnershipAttached) {
      return;
    }

    this.connectionTraceRecorder?.recordAppClientDisconnected(id);
    this.memoizedQueryTable.clearClient(id);
    this.rejectRoutes(
      this.pendingRoutes.clearByClientId(id),
      new Error(`Multiplexer runtime client ${id} disconnected`),
    );

    this.webSocketController?.sendClientList();
    this.sendSnapshot();
  };

  private readonly handleLegacyOwnershipChanged = (
    change: LegacyOwnershipChange,
  ): void => {
    if (change.status === "unattached") {
      this.connectionTraceRecorder?.recordLegacyOwnershipLost({
        ownerPid: change.ownerPid,
        previousOwnerPid: change.previousOwnerPid,
        reason: change.reason,
      });
      this.handleLegacyOwnershipLost();
    } else {
      this.connectionTraceRecorder?.recordLegacyOwnershipAttached({
        ownerPid: change.ownerPid,
        previousOwnerPid: change.previousOwnerPid,
        reason: change.reason,
      });
    }

    this.broadcast({
      kind: "event",
      event: "legacy-ownership-changed",
      data: change,
    });
  };

  private handleLegacyOwnershipLost(): void {
    // Preserve discovered devices for reacquisition, but invalidate runtime
    // state owned by the lost legacy connection.
    this.clearAllClientWatcherStartState();
    this.memoizedQueryTable.clear();
    this.rejectRoutes(
      this.pendingRoutes.clear(),
      new Error("Multiplexer legacy owner was preempted"),
    );
    this.physicalConnector.disableAllClients();
    this.physicalConnector.usbClients.clear();
    this.getWebSocketAppClients()?.forEach((client) => client.close());
    this.sendSnapshot();
    this.webSocketController?.sendClientList();
  }

  handleControlConnected(controlId: number): void {
    this.activeControlIds.add(controlId);
    this.connectionTraceRecorder?.recordControlSocketConnected(controlId, {
      activeControlCount: this.activeControlIds.size,
    });
    this.clearIdleTimeout();
    this.sendSnapshot([controlId]);
    const ownershipStatus = this.legacyOwnershipGuard.currentStatus;
    if (ownershipStatus !== "unInit") {
      this.sendToControl(controlId, {
        kind: "event",
        event: "legacy-ownership-changed",
        data: {
          status: ownershipStatus,
          ownerPid: process.pid,
          reason:
            ownershipStatus === "attached"
              ? "daemon-started"
              : "legacy-preempted",
        },
      });
    }
  }

  handleControlDisconnected(controlId: number): void {
    this.activeControlIds.delete(controlId);
    this.connectionTraceRecorder?.recordControlSocketDisconnected(controlId, {
      activeControlCount: this.activeControlIds.size,
    });
    this.webSocketRequesterControlIds.delete(controlId);
    // Routes belong to their requester; shared runtime caches survive a control disconnect.
    this.rejectRoutes(
      this.pendingRoutes.clearByControlId(controlId),
      new Error(`Multiplexer control ${controlId} disconnected`),
    );
    this.scheduleIdleTimeoutIfNeeded();
  }

  handleWebSocketClientConnected(clientId: number, type: string): void {
    // Runtime Apps are resources; only Driver frontends are consumers that keep the daemon alive.
    if (type === "Driver") {
      this.activeWebSocketDriverIds.add(clientId);
      this.clearIdleTimeout();
    }
    this.sendSnapshot(this.webSocketRequesterControlIds);
  }

  handleWebSocketClientDisconnected(clientId: number, type: string): void {
    if (type === "Driver") {
      this.activeWebSocketDriverIds.delete(clientId);
      this.pendingRoutes.clearByWebClientId(clientId);
      this.scheduleIdleTimeoutIfNeeded();
    } else {
      this.memoizedQueryTable.clearClient(clientId);
      this.rejectRoutes(
        this.pendingRoutes.clearByClientId(clientId),
        new Error(`Multiplexer runtime client ${clientId} disconnected`),
      );
    }
    this.sendSnapshot(this.webSocketRequesterControlIds);
  }

  emit<Event extends keyof DebugerRouterDriverEvents>(
    event: Event,
    payload: DebugerRouterDriverEvents[Event],
  ): void {
    switch (event) {
      case "ws-client-message":
      case "ws-web-message":
        this.sendToWebSocketRequesters({
          kind: "event",
          event: "client-message",
          data: {
            source:
              event === "ws-client-message"
                ? "websocket-runtime"
                : "websocket-driver",
            ...(payload as { id: number; message: string }),
          },
        });
        break;
      case "websocket-app-client-connected": {
        const client = payload as WebSocketClient;
        this.connectionTraceRecorder?.recordWebsocketAppClientConnected(client);
        this.handleWebSocketClientConnected(client.clientId(), client.type());
        break;
      }
      case "websocket-web-client-connected": {
        const client = payload as WebSocketClient;
        this.connectionTraceRecorder?.recordWebsocketWebClientConnected(client);
        this.handleWebSocketClientConnected(client.clientId(), client.type());
        break;
      }
      case "websocket-app-client-disconnected": {
        const clientId = payload as number;
        this.connectionTraceRecorder?.recordWebsocketAppClientDisconnected(
          clientId,
        );
        this.handleWebSocketClientDisconnected(clientId, "runtime");
        break;
      }
      case "websocket-web-client-disconnected": {
        const clientId = payload as number;
        this.connectionTraceRecorder?.recordWebsocketWebClientDisconnected(
          clientId,
        );
        this.handleWebSocketClientDisconnected(clientId, "Driver");
        break;
      }
      default:
        // Generic app lifecycle events and their websocket-specific variants
        // are derived by each Connector from snapshots.
        break;
    }
  }

  async handleControlRpc(
    controlId: number,
    message: ControlRpcRequest,
  ): Promise<unknown> {
    switch (message.method) {
      case "connectDevices":
        return this.connectDevices(
          message.params as ControlRpcParams["connectDevices"],
        );
      case "connectUsbClients":
        return this.connectUsbClients(
          message.params as ControlRpcParams["connectUsbClients"],
        );
      case "startDeviceClientWatcher":
        return this.startWatchClient(
          (message.params as ControlRpcParams["startDeviceClientWatcher"])
            .deviceId,
        );
      case "stopDeviceClientWatcher":
        return this.stopWatchClient(
          (message.params as ControlRpcParams["stopDeviceClientWatcher"])
            .deviceId,
        );
      case "startAllDeviceClientWatchers":
        return this.startWatchAllClients();
      case "stopAllDeviceClientWatchers":
        return this.forceDisableAllClients();
      case "disconnectDevice":
        return this.disconnectDevice(
          message.params as ControlRpcParams["disconnectDevice"],
        );
      case "shutdownDaemon":
        this.requestDaemonShutdown(
          (message.params as ControlRpcParams["shutdownDaemon"]).reason,
        );
        return undefined;
      case "startWSServer":
        return this.startWSServer(controlId);
      case "sendMessageWithReply":
        return this.sendMessageWithReply(
          message.params as ControlRpcParams["sendMessageWithReply"],
          controlId,
        );
      case "sendMessageWithoutReply":
        this.sendMessageWithoutReply(
          message.params as ControlRpcParams["sendMessageWithoutReply"],
          controlId,
        );
        return undefined;
      case "closeClient":
        this.closeClient(
          (message.params as ControlRpcParams["closeClient"]).clientId,
        );
        return undefined;
      default:
        throw {
          code: "unknown-control-rpc",
          message: `Unknown multiplexer control RPC: ${
            (message as ControlRpcRequest).method
          }`,
        };
    }
  }

  private async connectDevices(
    params: ControlRpcParams["connectDevices"],
  ): Promise<DeviceSnapshot[]> {
    return this.serializeDevices(
      await this.physicalConnector.connectDevices(
        params.timeout ?? -1,
        params.serial ?? null,
      ),
    );
  }

  private async connectUsbClients(
    params: ControlRpcParams["connectUsbClients"],
  ): Promise<ClientSnapshot[]> {
    defaultLogger.debug(
      "connectUsbClients of :" +
        params.deviceId +
        " waitTimeout:" +
        (params.waitTimeout ?? true) +
        " timeout:" +
        (params.timeout ?? -1),
    );
    if (!this.physicalConnector.devices.has(params.deviceId)) {
      defaultLogger.debug("connectUsbClients: resolve device == null");
      return [];
    }
    await this.ensureClientWatcher(params.deviceId);
    const clients =
      params.waitTimeout ?? true
        ? await this.physicalConnector.getDeviceUsbClients(
            params.deviceId,
            params.timeout ?? -1,
            params.clientName ?? null,
          )
        : await this.physicalConnector.waitDeviceUsbClients(
            params.deviceId,
            params.timeout ?? -1,
          );
    const snapshots = this.serializeClients(clients);
    const clientInfos = clients.map((client) => client.info);
    defaultLogger.debug(
      "connectUsbClients: clients:" + JSON.stringify(clientInfos),
    );
    this.publishClientSnapshot();
    return snapshots;
  }

  private async startWatchClient(deviceId: string): Promise<void> {
    await this.ensureClientWatcher(deviceId);
  }

  private async ensureClientWatcher(deviceId: string): Promise<void> {
    const device = this.physicalConnector.devices.get(deviceId);
    if (!device) {
      defaultLogger.debug(
        "ensureClientWatcher: resolve device == null:" + deviceId,
      );
      return;
    }
    this.assertLegacyOwnershipAttached();
    if (this.clientWatcherStartedDeviceIds.has(deviceId)) {
      return;
    }

    // Concurrent facade requests share one watcher startup per physical device.
    const existing = this.clientWatcherStartingByDeviceId.get(deviceId);
    if (existing) return existing;

    const starting = Promise.resolve()
      .then(async () => {
        await this.physicalConnector.startWatchClient(
          device,
          () => this.legacyOwnershipAttached,
        );
        this.clientWatcherStartedDeviceIds.add(deviceId);
      })
      .finally(() => {
        if (this.clientWatcherStartingByDeviceId.get(deviceId) === starting) {
          this.clientWatcherStartingByDeviceId.delete(deviceId);
        }
      });

    this.clientWatcherStartingByDeviceId.set(deviceId, starting);
    await starting;
  }

  private async stopWatchClient(deviceId: string): Promise<void> {
    this.clearClientWatcherStartState(deviceId);
    await this.physicalConnector.devices.get(deviceId)?.stopWatchClient();
  }

  private async startWatchAllClients(): Promise<void> {
    await this.legacyOwnershipGuard.reacquire();
    await this.ensureAllClientWatchers();
    this.publishClientSnapshot();
  }

  private async ensureAllClientWatchers(): Promise<void> {
    await Promise.all(
      Array.from(this.physicalConnector.devices.keys(), (deviceId) =>
        this.ensureClientWatcher(deviceId),
      ),
    );
  }

  private async forceDisableAllClients(): Promise<void> {
    await Promise.allSettled(
      Array.from(this.clientWatcherStartingByDeviceId.values()),
    );
    this.clientWatcherStartingByDeviceId.clear();
    this.clientWatcherStartedDeviceIds.clear();
    this.physicalConnector.disableAllClients();
    this.getWebSocketAppClients()?.forEach((client) => client.close());
    this.publishClientSnapshot();
  }

  private publishClientSnapshot(): void {
    this.webSocketController?.sendClientList();
    this.sendSnapshot();
  }

  private disconnectDevice(params: ControlRpcParams["disconnectDevice"]): void {
    this.clearClientWatcherStartState(params.deviceId);
    this.physicalConnector.devices.get(params.deviceId)?.disConnect();
  }

  private closeClient(clientId: number): void {
    const websocketClient = this.getWebSocketAppClients()?.get(clientId);
    if (websocketClient) {
      websocketClient.close();
      return;
    }
    this.physicalConnector.closeClient(clientId);
  }

  private requestDaemonShutdown(reason?: string): void {
    if (!this.shutdownHandler) {
      throw {
        code: "daemon-shutdown-unavailable",
        message: "Multiplexer daemon shutdown handler is not configured",
      };
    }
    if (this.shutdownRequested) {
      return;
    }

    this.shutdownRequested = true;
    this.daemonStopReason = reason ?? "control_request";
    this.connectionTraceRecorder?.recordDaemonShutdownRequested({
      reason: this.daemonStopReason,
    });
    this.clearIdleTimeout();
    const shutdownHandler = this.shutdownHandler;
    // Let the current control RPC send its response before entry tears down the process.
    setImmediate(() => {
      void shutdownHandler();
    });
  }

  private async startWSServer(controlId: number): Promise<WebSocketServerInfo> {
    if (!this.option.enableWebSocket) {
      throw {
        code: "websocket-disabled",
        message:
          "The multiplexer daemon does not support WebSocket because enableWebSocket is disabled",
      };
    }

    // Subscribe before awaiting startup so this control cannot miss concurrent WebSocket snapshots.
    this.webSocketRequesterControlIds.add(controlId);

    try {
      if (this.webSocketServerStarted) {
        const info = this.webSocketServerInfo;
        if (!info) {
          throw {
            code: "websocket-server-info-unavailable",
            message:
              "The multiplexer daemon WebSocket server information is unavailable",
          };
        }
        this.sendSnapshot([controlId]);
        return info;
      }

      if (!this.webSocketServerStarting) {
        // All concurrent requesters observe the same startup attempt and failure cleanup.
        this.webSocketServerStarting = this.startWebSocketServerInternal()
          .then((info) => {
            this.webSocketServerStarted = true;
            this.webSocketServerInfo = info;
            this.connectionTraceRecorder?.recordWebsocketServerStarted(info);
            return info;
          })
          .catch((error) => {
            const webSocketController = this.webSocketController;
            this.webSocketController = null;
            try {
              webSocketController?.close();
            } catch (closeError) {
              defaultLogger.warn(
                `Failed to close WebSocket controller after start failure: ${
                  closeError instanceof Error
                    ? closeError.message
                    : String(closeError)
                }`,
              );
            }
            throw error;
          })
          .finally(() => {
            this.webSocketServerStarting = null;
          });
      }

      const info = await this.webSocketServerStarting;
      this.sendSnapshot([controlId]);
      return info;
    } catch (error) {
      this.webSocketRequesterControlIds.delete(controlId);
      throw error;
    }
  }

  private async startWebSocketServerInternal(): Promise<WebSocketServerInfo> {
    const wssPort = await detectPort(DEFAULT_DEV_SERVE_PORT);
    const wssHost = `${address()}:${wssPort}`;
    const info: WebSocketServerInfo = {
      port: wssPort,
      host: wssHost,
      roomId: this.option.websocketOption?.roomId,
    };

    getDriverReportService()?.report("websocket_server_init", null, {
      port: "wssPort:" + wssHost,
    });

    await new Promise<void>((resolve) => {
      this.webSocketController = new WebSocketController(this, {
        port: wssPort,
        host: wssHost,
        roomId: this.option.websocketOption?.roomId,
        callback: resolve,
      });
    });
    return info;
  }

  private async sendMessageWithReply(
    params: ControlRpcParams["sendMessageWithReply"],
    controlId: number,
  ): Promise<ResponseMessageType> {
    return new Promise<ResponseMessageType>((resolve, reject) => {
      this.sendMessageToRuntime(params.clientId, params.message, {
        kind: "control",
        requesterId: controlId,
        clientId: params.clientId,
        resolve: (value) => resolve(value as ResponseMessageType),
        reject,
      });
    });
  }

  private sendMessageWithoutReply(
    params: ControlRpcParams["sendMessageWithoutReply"],
    controlId: number,
  ): void {
    const message =
      typeof params.message === "string"
        ? params.message
        : JSON.stringify(params.message);
    if (params.target === "web") {
      if (params.clientId === -1) {
        this.sendMessageToWeb(message);
      } else {
        this.sendMessageToWebClient(params.clientId, message);
      }
      return;
    }

    this.sendMessageToRuntime(params.clientId, message, {
      kind: "control",
      requesterId: controlId,
      clientId: params.clientId,
    });
  }

  broadcast(event: ControlEvent): void {
    this.controlServer?.broadcast(event);
  }

  sendToControl(controlId: number, event: ControlEvent): void {
    this.controlServer?.sendToControl(controlId, event);
  }

  private sendSnapshot(controlIds?: Iterable<number>): void {
    // An omitted target broadcasts authoritative state; explicit ids preserve
    // requester-scoped visibility.
    const event: ControlEvent = {
      kind: "event",
      event: "snapshot",
      data: this.createSnapshot(),
    };
    if (!controlIds) {
      this.broadcast(event);
      return;
    }
    for (const controlId of controlIds) {
      this.sendToControl(controlId, event);
    }
  }

  createSnapshot(): Snapshot {
    const generatedAt = this.now();
    // Ownership loss hides physical and WiFi runtimes while retaining live Driver frontends.
    const physicalDevices = this.legacyOwnershipAttached
      ? Array.from(this.physicalConnector.devices.values())
      : [];
    const physicalClients = this.legacyOwnershipAttached
      ? this.physicalConnector.getAllUsbClients()
      : [];
    const debugInfo = this.createDebugInfo(generatedAt);
    const snapshot: Snapshot = {
      protocolVersion: this.protocolVersion,
      generatedAt,
      devices: this.serializeDevices(physicalDevices),
      clients: this.serializeClients(physicalClients),
      ...(debugInfo ? { debugInfo } : {}),
    };
    const websocketAppClients = this.getWebSocketAppClients();
    const websocketWebClients = this.getWebSocketWebClients();
    if (websocketAppClients) {
      snapshot.websocketAppClients = this.legacyOwnershipAttached
        ? Array.from(websocketAppClients.values(), (client) =>
            this.serializeWebSocketClient(client),
          )
        : [];
    }
    if (websocketWebClients) {
      snapshot.websocketWebClients = Array.from(
        websocketWebClients.values(),
        (client) => this.serializeWebSocketClient(client),
      );
    }
    return snapshot;
  }

  serializeDevices(devices: BaseDevice[]): DeviceSnapshot[] {
    return devices.map((device) => this.serializeDevice(device));
  }

  private serializeDevice(device: BaseDevice): DeviceSnapshot {
    return {
      ...device.info,
      ports: [...device.ports],
      host: device.getHost(),
    };
  }

  serializeClients(clients: UsbClient[]): ClientSnapshot[] {
    return clients.map((client) => this.serializeClient(client));
  }

  private serializeClient(client: UsbClient): ClientSnapshot {
    return { ...client.info };
  }

  createClientId(): number {
    return this.physicalConnector.createClientId();
  }

  getAllUsbClients(): UsbClient[] {
    if (!this.legacyOwnershipAttached) {
      return [];
    }

    return this.physicalConnector.getAllUsbClients();
  }

  getDevices(
    timeout: number = -1,
    serial: string | null = null,
  ): Promise<BaseDevice[]> {
    if (!this.legacyOwnershipAttached) {
      return Promise.resolve([]);
    }

    return this.physicalConnector.getDevices(timeout, serial);
  }

  private createDebugInfo(
    timestamp: number = this.now(),
  ): MultiplexerDebugInfo | undefined {
    if (!this.option.debugInfo) {
      return undefined;
    }

    return {
      ...this.option.debugInfo,
      protocolVersion: this.protocolVersion,
      processId: process.pid,
      timestamp,
    };
  }

  private sendToWebSocketRequesters(event: ControlEvent): void {
    for (const controlId of this.webSocketRequesterControlIds) {
      this.sendToControl(controlId, event);
    }
  }

  private serializeWebSocketClient(
    client: WebSocketClient,
  ): WebSocketClientSnapshot {
    const info = client.info;
    return {
      id: info.id,
      app: info.app,
      debugRouterVersion: info.debugRouterVersion,
      deviceModel: info.deviceModel,
      network: "WiFi",
      osVersion: info.osVersion,
      sdkVersion: info.sdkVersion,
      type: info.type,
      raw_info: cloneJsonValue(info.raw_info) ?? null,
    };
  }

  private getWebSocketAppClients(): Map<number, WebSocketClient> | undefined {
    return this.webSocketController?.getAllWebsocketAppClients();
  }

  private getWebSocketWebClients(): Map<number, WebSocketClient> | undefined {
    return this.webSocketController?.getAllWebsocketWebClients();
  }

  private readonly handleUsbClientMessage = (
    payload: PhysicalConnectorEvent["usb-client-message"],
  ): void => {
    if (!this.legacyOwnershipAttached) {
      return;
    }

    this.handlePhysicalMessage(payload.id, payload.message);
  };

  handlePhysicalMessage(clientId: number, message: string): void {
    this.handleRuntimeMessage(clientId, message, "usb-runtime");
  }

  handleWebSocketAppMessage(appClientId: number, message: string): void {
    this.handleRuntimeMessage(appClientId, message, "websocket-runtime");
  }

  handleWebSocketDriverMessage(
    // Web Frontend -> Runtime
    webClientId: number,
    targetClientId: number,
    message: string,
  ): void {
    this.sendMessageToRuntime(targetClientId, message, {
      kind: "websocket",
      requesterId: webClientId,
      clientId: targetClientId,
    });
  }

  // This path may serve from cache or coalesce a query before it sends anything to the runtime.
  private sendMessageToRuntime(
    clientId: number,
    message: string | object,
    target: PendingTargetSeed,
  ): void {
    const websocketClient = this.getWebSocketAppClients()?.get(clientId);
    const usbClient = this.physicalConnector.usbClients.get(clientId);
    if (!websocketClient && !usbClient) {
      throw {
        code: "multiplexer-client-not-found",
        message: `Multiplexer client was not found: ${clientId}`,
      };
    }
    const data =
      typeof message === "string"
        ? parseJsonMessage(message)
        : cloneJsonValue(message);

    if (
      data?.data?.type === "UsbConnect" ||
      data?.data?.type === "UsbConnectAck"
    ) {
      return;
    }
    if (data?.data?.data?.client_id) {
      data.data.data.client_id = websocketClient ? clientId : -1;
    }

    const memoizedQuery = this.memoizedQueryTable.query(clientId, data);
    if (memoizedQuery.action === "cached") {
      this.sendMessageToTargetDriver(
        target,
        clientId,
        memoizedQuery.message,
        memoizedQuery.parsedValue,
      );
      return;
    }
    if (memoizedQuery.action === "pending") {
      return;
    }

    // Register the route before sending so an immediate runtime response can be correlated.
    const route = this.rewriteOutboundMessageData(data, target);
    // Retry the normalized payload directly; re-entering this method would
    // coalesce it as already pending.
    const retryMessage =
      memoizedQuery.action === "forward" ? cloneJsonValue(data) : undefined;
    try {
      if (websocketClient) {
        websocketClient.sendMessage(JSON.stringify(data));
      } else {
        usbClient!.sendMessage(data);
      }
    } catch (error) {
      if (memoizedQuery.action === "forward") {
        this.memoizedQueryTable.handleSendFailure(
          clientId,
          memoizedQuery.requestType,
        );
      }
      if (route) {
        this.pendingRoutes.take(route.globalMessageId);
      }
      throw error;
    }

    if (memoizedQuery.action === "forward") {
      this.memoizedQueryTable.setRetryTimer(
        clientId,
        memoizedQuery.requestType,
        () => {
          try {
            if (websocketClient) {
              websocketClient.sendMessage(JSON.stringify(retryMessage));
              return true;
            }
            if (usbClient) {
              usbClient.sendMessage(retryMessage);
              return true;
            }
          } catch (error) {
            defaultLogger.warn(
              `Stop retrying memoized query for runtime ${clientId}: ${
                error instanceof Error ? error.message : String(error)
              }`,
            );
          }
          return false;
        },
      );
    }
  }

  private sendMessageToTargetDriver(
    target: PendingTargetSeed,
    clientId: number,
    message: string,
    parsedValue: unknown,
  ): void {
    if (target.kind === "control") {
      if (target.resolve) {
        target.resolve(normalizeRawResponse(parsedValue, clientId));
        return;
      }
      this.sendToControl(target.requesterId, {
        kind: "event",
        event: "client-message",
        data: {
          source: this.getWebSocketAppClients()?.has(clientId)
            ? "websocket-runtime"
            : "usb-runtime",
          id: clientId,
          message,
        },
      });
      return;
    }

    this.sendMessageToWebClient(target.requesterId, message);
  }

  private rewriteOutboundMessageData(
    data: any,
    target: PendingTargetSeed,
  ): PendingRoute | null {
    const customized = getCustomizedPayload(data);
    const originalId = getValidMessageId(customized?.message);
    if (!customized || originalId === null) {
      return null;
    }

    const route = this.pendingRoutes.add({
      ...target,
      originalId,
      clientId: target.clientId,
    });

    customized.message.id = route.globalMessageId;
    writeCustomizedMessage(customized);
    return route;
  }

  // Separates point-to-point responses from notifications shared with every requester.
  private handleRuntimeMessage(
    clientId: number,
    message: string,
    source: "usb-runtime" | "websocket-runtime",
  ): void {
    const parsedValue = parseJsonMessageOrNull(message);
    const customized = getCustomizedPayload(parsedValue);
    const routed = this.restoreInboundMessage(
      parsedValue,
      customized,
      clientId,
    );
    if (routed) {
      if (routed.target.kind === "control") {
        if (routed.target.resolve) {
          routed.target.resolve(
            normalizeRawResponse(routed.parsedValue, routed.clientId),
          );
        } else {
          // Connector facade events are a legacy compatibility surface.
          // parsedValue restores the caller's original request id without
          // exposing the sender/client_id rewrite used for Web routing.
          this.sendToControl(routed.target.requesterId, {
            kind: "event",
            event: "client-message",
            data: {
              source,
              id: routed.clientId,
              message: JSON.stringify(routed.parsedValue),
            },
          });
        }
      } else {
        rewriteRuntimeClientIdData(routed.parsedValue, routed.clientId);
        this.sendMessageToWebClient(
          routed.target.requesterId,
          JSON.stringify(routed.parsedValue),
        );
      }
      return;
    }

    // An ID-bearing response without a live route cannot be safely attributed or broadcast.
    if (getValidMessageId(customized?.message) !== null) {
      defaultLogger.debug(
        `Drop multiplexer response with unknown message id from client ${clientId}`,
      );
      return;
    }

    // Web frontends and the notification cache need the daemon-assigned
    // runtime identity for routing. Connector facades instead receive the
    // runtime's original string below, preserving the legacy event payload
    // byte-for-byte for idless notifications.
    let broadcastMessage = message;
    if (parsedValue) {
      rewriteRuntimeClientIdData(parsedValue, clientId);
      broadcastMessage = JSON.stringify(parsedValue);
    }
    this.memoizedQueryTable.recordNotification(
      clientId,
      broadcastMessage,
      parsedValue,
    );
    if (this.option.enableWebSocket) {
      this.sendMessageToWeb(broadcastMessage);
    }
    this.broadcast({
      kind: "event",
      event: "client-message",
      data: {
        source,
        id: clientId,
        message,
      },
    });
  }

  // Claims a matching one-shot route and restores the requester's original message id.
  restoreInboundMessage(
    parsedValue: any | null,
    customized: CustomizedPayload | null,
    sourceClientId: number,
  ): RoutedMessage | null {
    if (!parsedValue) {
      return null;
    }

    const globalMessageId = getValidMessageId(customized?.message);
    if (globalMessageId === null) {
      return null;
    }

    const pendingTarget = this.pendingRoutes.get(globalMessageId);
    // Validate the runtime origin before consuming a globally unique route.
    if (pendingTarget && pendingTarget.clientId !== sourceClientId) {
      defaultLogger.warn(
        `Drop multiplexer response with global message id ${globalMessageId} ` +
          `from runtime ${sourceClientId}; expected runtime ${pendingTarget.clientId}`,
      );
      return null;
    }

    const target = this.pendingRoutes.take(globalMessageId);
    if (!target) {
      return null;
    }

    if (customized) {
      customized.message.id = target.originalId;
      writeCustomizedMessage(customized);
    }

    return {
      target,
      clientId: target.clientId,
      parsedValue,
    };
  }

  sendMessageToWeb(message: string): void {
    if (!this.option.enableWebSocket) {
      defaultLogger.warn("enableWebSocket isn't opened!");
      return;
    }

    if (!this.webSocketController) {
      defaultLogger.warn("websocket server hasn't started up");
      return;
    }

    this.webSocketController.sendMessageToWeb(message);
  }

  sendMessageToWebClient(webClientId: number, message: string): void {
    if (!this.option.enableWebSocket) {
      defaultLogger.warn("enableWebSocket isn't opened!");
      return;
    }

    if (!this.webSocketController) {
      defaultLogger.warn("websocket server hasn't started up");
      return;
    }

    this.webSocketController.sendMessageToWebClient(webClientId, message);
  }

  private bindPhysicalConnectorEvents(): void {
    this.physicalConnector.on("device-connected", this.handleDeviceConnected);
    this.physicalConnector.on(
      "device-disconnected",
      this.handleDeviceDisconnected,
    );
    this.physicalConnector.on("client-connected", this.handleClientConnected);
    this.physicalConnector.on(
      "client-disconnected",
      this.handleClientDisconnected,
    );
    this.physicalConnector.on(
      "usb-client-message",
      this.handleUsbClientMessage,
    );
  }

  private unbindPhysicalConnectorEvents(): void {
    this.physicalConnector.off("device-connected", this.handleDeviceConnected);
    this.physicalConnector.off(
      "device-disconnected",
      this.handleDeviceDisconnected,
    );
    this.physicalConnector.off("client-connected", this.handleClientConnected);
    this.physicalConnector.off(
      "client-disconnected",
      this.handleClientDisconnected,
    );
    this.physicalConnector.off(
      "usb-client-message",
      this.handleUsbClientMessage,
    );
  }

  private clearClientWatcherStartState(deviceId: string): void {
    this.clientWatcherStartedDeviceIds.delete(deviceId);
    this.clientWatcherStartingByDeviceId.delete(deviceId);
  }

  private clearAllClientWatcherStartState(): void {
    this.clientWatcherStartedDeviceIds.clear();
    this.clientWatcherStartingByDeviceId.clear();
  }

  private clearRuntimeState(): void {
    this.clearAllClientWatcherStartState();
    this.memoizedQueryTable.clear();
    this.rejectRoutes(
      this.pendingRoutes.clear(),
      new Error("Multiplexer host route table was reset"),
    );
  }

  private rejectRoutes(routes: PendingRoute[], error: Error): void {
    for (const route of routes) {
      if (route.kind === "control") {
        route.reject?.(error);
      }
    }
  }

  private assertLegacyOwnershipAttached(): void {
    if (!this.legacyOwnershipAttached) {
      throw new Error("Multiplexer legacy owner is not attached");
    }
  }

  // Runtime Apps do not own daemon lifetime; only controls and Driver frontends do.
  private scheduleIdleTimeoutIfNeeded(): void {
    if (!this.started || !this.idleTimeoutHandler) {
      return;
    }

    const idleTimeout = this.option.multiplexerDaemonIdleTimeout;
    if (idleTimeout < 0 || this.isInUse()) {
      return;
    }

    this.clearIdleTimeout();
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      // A new consumer may have connected while this timer was waiting.
      if (this.isInUse()) {
        return;
      }
      this.daemonStopReason = "idle_timeout";
      this.connectionTraceRecorder?.recordDaemonIdleTimeoutReached({
        idleTimeout,
      });
      void this.idleTimeoutHandler?.();
    }, idleTimeout);
  }

  private clearIdleTimeout(): void {
    if (!this.idleTimer) {
      return;
    }

    clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }
}

function createStopError(errors: unknown[]): Error {
  const message = errors
    .map((error) => (error instanceof Error ? error.message : String(error)))
    .join("; ");
  const stopError = new Error(`Failed to stop multiplexer host: ${message}`);
  (stopError as any).errors = errors;
  return stopError;
}

function cloneJsonValue(value: unknown): unknown {
  if (value === undefined || value === null) {
    return value;
  }

  try {
    return JSON.parse(JSON.stringify(value));
  } catch (_error) {
    return undefined;
  }
}

function parseJsonMessage(message: string): any {
  try {
    return JSON.parse(message);
  } catch (error: any) {
    throw {
      code: "invalid-json-message",
      message: `Invalid JSON message for multiplexer app client: ${error?.message}`,
    };
  }
}

function parseJsonMessageOrNull(message: string): any | null {
  try {
    return JSON.parse(message);
  } catch (_error) {
    return null;
  }
}

function getCustomizedPayload(data: any): CustomizedPayload | null {
  const container = data?.data?.data;
  if (
    !container ||
    !Object.prototype.hasOwnProperty.call(container, "message")
  ) {
    return null;
  }

  const rawMessage = container.message;
  const messageWasString = typeof rawMessage === "string";
  const message = messageWasString
    ? parseJsonMessageOrNull(rawMessage)
    : rawMessage;
  if (typeof message !== "object" || message === null) {
    return null;
  }

  return { container, message, messageWasString };
}

function writeCustomizedMessage(payload: CustomizedPayload): void {
  if (payload.messageWasString) {
    payload.container.message = JSON.stringify(payload.message);
  }
}

function getValidMessageId(message: any | null | undefined): number | null {
  return Number.isSafeInteger(message?.id) ? message.id : null;
}

function normalizeRawResponse(
  data: any,
  clientId: number,
): ResponseMessageType {
  if (!data?.data?.data) {
    return data as ResponseMessageType;
  }

  const responsePayload = { ...data.data.data };
  if (Object.prototype.hasOwnProperty.call(responsePayload, "client_id")) {
    responsePayload.client_id = clientId;
  }
  if (
    Object.prototype.hasOwnProperty.call(responsePayload, "message") &&
    typeof responsePayload.message !== "string"
  ) {
    responsePayload.message = JSON.stringify(responsePayload.message);
  }

  return {
    ...data,
    data: {
      ...data.data,
      data: responsePayload,
    },
  } as ResponseMessageType;
}

function rewriteRuntimeClientIdData(data: any, clientId: number): void {
  if (data?.data && Object.prototype.hasOwnProperty.call(data.data, "sender")) {
    data.data.sender = clientId;
  }
  if (
    data?.data?.data &&
    Object.prototype.hasOwnProperty.call(data.data.data, "client_id")
  ) {
    data.data.data.client_id = clientId;
  }
}
