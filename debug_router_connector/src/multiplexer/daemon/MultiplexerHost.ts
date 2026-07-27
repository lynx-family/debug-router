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
  ClientDescription,
  DebugerRouterDriverEvents,
  DeviceDescription,
  PhysicalConnectorEvent,
  ResponseMessageType,
} from "../../utils/type";
import {
  ClientSnapshot,
  ControlEvent,
  ControlRpcError,
  ControlRpcParams,
  ControlRpcRequest,
  DeviceSnapshot,
  MULTIPLEXER_MIN_SUPPORTED_PROTOCOL_VERSION,
  MULTIPLEXER_PROTOCOL_VERSION,
  MultiplexerDebugInfo,
  Snapshot,
  WebSocketClientSnapshot,
  WebSocketServerInfo,
} from "../protocol";
import { MultiplexerDaemonHost } from "./MultiplexerDaemon";
import {
  MultiplexerControlHost,
  MultiplexerControlServer,
} from "./MultiplexerControlServer";
import {
  LegacyOwnershipChange,
  LegacyOwnershipGuard,
} from "./LegacyOwnershipGuard";
import { MemoizedNotificationQueryTable } from "./MemoizedNotificationQueryTable";
import { PendingRoute, PendingRouteTable } from "./PendingRouteTable";
import {
  ConnectionTraceRecorder,
  createConnectionTraceRecorder,
} from "../../trace/ConnectionTraceRecorder";

const DEFAULT_DEV_SERVE_PORT = 19783;

export type PendingTargetSeed =
  | {
      kind: "control";
      controlId: number;
      clientId: number;
      resolve?: (value: unknown) => void;
      reject?: (error: Error) => void;
    }
  | {
      kind: "websocket";
      webClientId: number;
      clientId: number;
    };

export type RoutedMessage = {
  target: PendingRoute;
  clientId: number;
  message: string;
  externalMessage: string;
};

type CustomizedPayload = {
  container: any;
  message: any;
  messageWasString: boolean;
};

type WebSocketControllerLike = {
  sendMessageToWeb(message: string): void;
  sendMessageToWebClient(webClientId: number, message: string): void;
  sendClientList(): void;
  sendDeviceList(): void;
  getAllWebsocketAppClients?(): Map<number, WebSocketClient>;
  getAllWebsocketWebClients?(): Map<number, WebSocketClient>;
  closeAllWebsocketAppClients?(): void;
  close(): void;
};

export type MultiplexerHostOption = Omit<
  PhysicalConnectorOption,
  "traceRecorder"
> & {
  controlPort?: number;
  protocolVersion?: number;
  minSupportedProtocolVersion?: number;
  debugInfo?: MultiplexerDebugInfo;
  legacyDriverDir?: string;
  multiplexerDaemonIdleTimeout?: number;
  memoizedNotificationTtlMs?: number;
  websocketOption?: {
    port?: number;
    roomId?: string;
  };

  // only used for tests or embedding
  physicalConnector?: PhysicalConnector;
  PhysicalConnectorCtor?: new (
    option?: PhysicalConnectorOption,
  ) => PhysicalConnector;
  now?: () => number;
};

type MultiplexerHostStartOption = {
  multiplexerDaemonIdleTimeout?: number;
};

export class MultiplexerHost
  implements MultiplexerDaemonHost, MultiplexerControlHost {
  private physicalConnector: PhysicalConnector;
  private readonly connectionTraceRecorder: ConnectionTraceRecorder | null;
  private connectionTraceRecorderClosed = false;
  private readonly option: MultiplexerHostOption;
  private readonly protocolVersion: number;
  private readonly minSupportedProtocolVersion: number;
  private readonly now: () => number;
  private readonly pendingRoutes: PendingRouteTable;
  private readonly memoizedNotificationQueryTable: MemoizedNotificationQueryTable;
  private controlServer: MultiplexerControlServer | null = null;
  private webSocketController: WebSocketControllerLike | null = null;
  private webSocketServerInfo: WebSocketServerInfo | undefined;
  private deviceDiscoveryStarted = false;
  private deviceDiscoveryStarting: Promise<void> | null = null;
  private deviceDiscoveryAutoListensClients = false;
  private readonly clientDiscoveryStartedDeviceIds = new Set<string>();
  private readonly clientDiscoveryStartingByDeviceId = new Map<
    string,
    Promise<void>
  >();
  private allClientWatchersRequested = false;
  private webSocketServerStarted = false;
  private webSocketServerStarting: Promise<WebSocketServerInfo> | null = null;
  private readonly activeControlIds = new Set<number>();
  private readonly webSocketRequesterControlIds = new Set<number>();
  private readonly activeWebSocketDriverIds = new Set<number>();
  private readonly legacyOwnershipGuard: LegacyOwnershipGuard;
  private physicalDiscoveryGeneration = 0;
  private clientWatchGeneration = 0;
  private legacyOwnershipAttached = false;
  private idleTimer: NodeJS.Timeout | null = null;
  private idleTimeoutHandler: (() => void | Promise<void>) | undefined;
  private shutdownHandler: (() => void | Promise<void>) | undefined;
  private runtimeIdleTimeout: number | undefined;
  private nextGlobalMessageId = 1;
  private started = false;
  private shutdownRequested = false;
  private daemonStopReason: string | undefined;

  private readonly handleDeviceConnected = (device: BaseDevice): void => {
    if (!this.legacyOwnershipAttached) {
      return;
    }

    if (
      this.deviceDiscoveryAutoListensClients ||
      this.allClientWatchersRequested
    ) {
      void this.ensureClientDiscovery(device.serial);
    }

    this.webSocketController?.sendDeviceList();
    this.publishSnapshot();
  };

  private readonly handleDeviceDisconnected = (device: BaseDevice): void => {
    if (!this.legacyOwnershipAttached) {
      return;
    }

    this.clearClientDiscoveryForDevice(device.serial);

    this.webSocketController?.sendDeviceList();
    this.publishSnapshot();
  };

  private readonly handleClientConnected = (client: UsbClient): void => {
    if (!this.legacyOwnershipAttached) {
      return;
    }

    this.connectionTraceRecorder?.recordAppClientConnected(client);
    this.webSocketController?.sendClientList();
    this.publishSnapshot();
  };

  private readonly handleClientDisconnected = (id: number): void => {
    if (!this.legacyOwnershipAttached) {
      return;
    }

    this.connectionTraceRecorder?.recordAppClientDisconnected(id);
    this.memoizedNotificationQueryTable.clearClient(id);
    this.rejectRoutes(
      this.pendingRoutes.clearByClientId(id),
      new Error(`Multiplexer runtime client ${id} disconnected`),
    );

    this.webSocketController?.sendClientList();
    this.publishSnapshot();
  };

  private readonly handleUsbClientMessage = (
    payload: PhysicalConnectorEvent["usb-client-message"],
  ): void => {
    if (!this.legacyOwnershipAttached) {
      return;
    }

    this.handlePhysicalMessage(payload.id, payload.message);
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
      this.legacyOwnershipAttached = true;
    }

    this.broadcast({
      kind: "event",
      event: "legacy-ownership-changed",
      data: change,
    });
  };

  constructor(option: MultiplexerHostOption = {}) {
    this.option = option;
    this.protocolVersion =
      option.protocolVersion ?? MULTIPLEXER_PROTOCOL_VERSION;
    this.minSupportedProtocolVersion =
      option.minSupportedProtocolVersion ??
      MULTIPLEXER_MIN_SUPPORTED_PROTOCOL_VERSION;
    this.now = option.now ?? Date.now;
    this.pendingRoutes = new PendingRouteTable({
      now: this.now,
    });
    this.memoizedNotificationQueryTable = new MemoizedNotificationQueryTable({
      ttlMs: option.memoizedNotificationTtlMs,
      now: this.now,
    });

    this.connectionTraceRecorder = createConnectionTraceRecorder(
      option.connectionTrace,
      process.env.DriverConnectionTracePath,
    );
    this.physicalConnector = this.createPhysicalConnector();
    this.legacyOwnershipGuard = new LegacyOwnershipGuard({
      legacyDriverDir: option.legacyDriverDir,
      onStatusChanged: this.handleLegacyOwnershipChanged,
    });
  }

  async start(startOption?: unknown): Promise<void> {
    if (this.started) {
      return;
    }

    this.shutdownRequested = false;
    this.daemonStopReason = undefined;
    if (
      isMultiplexerHostStartOption(startOption) &&
      startOption.multiplexerDaemonIdleTimeout !== undefined
    ) {
      this.runtimeIdleTimeout = startOption.multiplexerDaemonIdleTimeout;
    }
    this.bindPhysicalConnectorEvents();

    const controlServer = new MultiplexerControlServer({
      host: this,
      controlPort: this.option.controlPort,
      protocolVersion: this.protocolVersion,
      minSupportedProtocolVersion: this.minSupportedProtocolVersion,
      ...(this.option.debugInfo ? { debugInfo: this.option.debugInfo } : {}),
      now: this.now,
    });

    this.controlServer = controlServer;

    try {
      await controlServer.start();
      this.started = true;
      const debugInfo = this.createDebugInfo();
      this.connectionTraceRecorder?.recordDaemonStarted({
        pid: process.pid,
        controlPort: controlServer.controlPort,
        protocolVersion: this.protocolVersion,
        minSupportedProtocolVersion: this.minSupportedProtocolVersion,
        ...(debugInfo ? { debugInfo } : {}),
      });
      this.legacyOwnershipGuard.start();
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
      (!this.connectionTraceRecorder || this.connectionTraceRecorderClosed)
    ) {
      return;
    }

    const stopErrors: unknown[] = [];
    const wasStarted = this.started;
    const daemonStopReason = this.daemonStopReason;
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
        this.recordWebsocketServerStopped(webSocketServerInfo, "daemon_stop");
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
      this.resetDiscoveryState();
    }

    if (wasStarted) {
      this.connectionTraceRecorder?.recordDaemonStopped({
        pid: process.pid,
        reason: daemonStopReason,
      });
    }
    this.daemonStopReason = undefined;

    if (this.connectionTraceRecorder && !this.connectionTraceRecorderClosed) {
      try {
        await this.connectionTraceRecorder.close();
        this.connectionTraceRecorderClosed = true;
      } catch (error) {
        stopErrors.push(error);
      }
    }

    if (stopErrors.length > 0) {
      throw createStopError(stopErrors);
    }
  }

  getControlPort(): number {
    return this.controlServer?.controlPort ?? this.option.controlPort ?? 0;
  }

  setIdleTimeoutHandler(handler: () => void | Promise<void>): void {
    this.idleTimeoutHandler = handler;
    this.scheduleIdleTimeoutIfNeeded();
  }

  setShutdownHandler(handler: () => void | Promise<void>): void {
    this.shutdownHandler = handler;
  }

  handleControlConnected(controlId: number): void {
    this.activeControlIds.add(controlId);
    this.connectionTraceRecorder?.recordControlSocketConnected(controlId, {
      activeControlCount: this.activeControlIds.size,
    });
    this.clearIdleTimeout();
    this.sendToControl(controlId, {
      kind: "event",
      event: "snapshot",
      data: this.createSnapshot(),
    });
  }

  handleControlDisconnected(controlId: number): void {
    this.activeControlIds.delete(controlId);
    this.connectionTraceRecorder?.recordControlSocketDisconnected(controlId, {
      activeControlCount: this.activeControlIds.size,
    });
    this.webSocketRequesterControlIds.delete(controlId);
    this.rejectRoutes(
      this.pendingRoutes.clearByControlId(controlId),
      new Error(`Multiplexer control ${controlId} disconnected`),
    );
    this.scheduleIdleTimeoutIfNeeded();
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
        return this.startWatchAllClients(
          message.params as ControlRpcParams["startAllDeviceClientWatchers"],
        );
      case "stopAllDeviceClientWatchers":
        return this.stopWatchAllClients(
          message.params as ControlRpcParams["stopAllDeviceClientWatchers"],
        );
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
        return this.sendRawMessage(
          message.params as ControlRpcParams["sendMessageWithReply"],
          controlId,
        );
      case "sendMessageWithoutReply":
        this.sendMessageFromConnector(
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
        throw createControlError(
          "unknown-control-rpc",
          `Unknown multiplexer control RPC: ${
            (message as ControlRpcRequest).method
          }`,
        );
    }
  }

  broadcast(event: ControlEvent): void {
    this.controlServer?.broadcast(event);
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
      case "websocket-app-client-connected":
        this.connectionTraceRecorder?.recordWebsocketAppClientConnected(
          payload as WebSocketClient,
        );
        break;
      case "websocket-web-client-connected":
        this.connectionTraceRecorder?.recordWebsocketWebClientConnected(
          payload as WebSocketClient,
        );
        break;
      case "websocket-app-client-disconnected":
        this.connectionTraceRecorder?.recordWebsocketAppClientDisconnected(
          payload as number,
        );
        break;
      case "websocket-web-client-disconnected":
        this.connectionTraceRecorder?.recordWebsocketWebClientDisconnected(
          payload as number,
        );
        break;
      default:
        // Generic app lifecycle events and their websocket-specific variants
        // are derived by each Connector from snapshots.
        break;
    }
  }

  sendToControl(controlId: number, event: ControlEvent): void {
    this.controlServer?.sendToControl(controlId, event);
  }

  private sendToWebSocketRequesters(event: ControlEvent): void {
    for (const controlId of this.webSocketRequesterControlIds) {
      this.sendToControl(controlId, event);
    }
  }

  private sendSnapshotToControl(controlId: number): void {
    this.sendToControl(controlId, {
      kind: "event",
      event: "snapshot",
      data: this.createSnapshot(),
    });
  }

  private sendSnapshotToWebSocketRequesters(): void {
    this.sendToWebSocketRequesters({
      kind: "event",
      event: "snapshot",
      data: this.createSnapshot(),
    });
  }

  publishSnapshot(snapshot: Snapshot = this.createSnapshot()): void {
    this.broadcast({
      kind: "event",
      event: "snapshot",
      data: snapshot,
    });
  }

  createSnapshot(): Snapshot {
    const generatedAt = this.now();
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
      snapshot.websocketAppClients = Array.from(
        websocketAppClients.values(),
        (client) => this.serializeWebSocketClient(client),
      );
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

  serializeClients(clients: UsbClient[]): ClientSnapshot[] {
    return clients.map((client) => this.serializeClient(client));
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

  handleWebSocketMessage(
    // Web Frontend -> Runtime
    webClientId: number,
    targetClientId: number,
    message: string,
  ): void {
    this.sendMessageToRuntime(targetClientId, message, {
      kind: "websocket",
      webClientId,
      clientId: targetClientId,
    });
  }

  handleWebSocketAppMessage(appClientId: number, message: string): void {
    this.handleRuntimeMessage(appClientId, message, "websocket-runtime");
  }

  handleWebSocketClientConnected(clientId: number, type?: string): void {
    if (isWebSocketDriverType(type)) {
      this.activeWebSocketDriverIds.add(clientId);
      this.clearIdleTimeout();
    }
    this.sendSnapshotToWebSocketRequesters();
  }

  handleWebSocketClientDisconnected(clientId: number, type?: string): void {
    let shouldScheduleIdleTimeout = false;
    if (isWebSocketDriverType(type)) {
      this.activeWebSocketDriverIds.delete(clientId);
      this.pendingRoutes.clearByWebClientId(clientId);
      shouldScheduleIdleTimeout = true;
    } else if (type !== undefined) {
      this.memoizedNotificationQueryTable.clearClient(clientId);
      this.rejectRoutes(
        this.pendingRoutes.clearByClientId(clientId),
        new Error(`Multiplexer runtime client ${clientId} disconnected`),
      );
    } else {
      shouldScheduleIdleTimeout = this.activeWebSocketDriverIds.delete(
        clientId,
      );
      this.pendingRoutes.clearByWebClientId(clientId);
      this.memoizedNotificationQueryTable.clearClient(clientId);
      this.rejectRoutes(
        this.pendingRoutes.clearByClientId(clientId),
        new Error(`Multiplexer WebSocket client ${clientId} disconnected`),
      );
    }
    this.sendSnapshotToWebSocketRequesters();
    if (shouldScheduleIdleTimeout) {
      this.scheduleIdleTimeoutIfNeeded();
    }
  }

  handlePhysicalMessage(clientId: number, message: string): void {
    this.handleRuntimeMessage(clientId, message, "usb-runtime");
  }

  private handleRuntimeMessage(
    clientId: number,
    message: string,
    source: "usb-runtime" | "websocket-runtime",
  ): void {
    const routed = this.restoreInboundMessage(message, clientId);
    if (routed) {
      if (routed.target.kind === "control") {
        if (routed.target.resolve) {
          routed.target.resolve(
            parseRawResponse(routed.externalMessage, routed.clientId),
          );
        } else {
          // Connector facade events are a legacy compatibility surface.
          // externalMessage restores the caller's original request id without
          // exposing the sender/client_id rewrite used for Web routing.
          this.sendToControl(routed.target.controlId, {
            kind: "event",
            event: "client-message",
            data: {
              source,
              id: routed.clientId,
              message: routed.externalMessage,
            },
          });
        }
      } else {
        this.sendMessageToWebClient(routed.target.webClientId, routed.message);
      }
      return;
    }

    if (hasResponseId(message)) {
      defaultLogger.debug(
        `Drop multiplexer response with unknown message id from client ${clientId}`,
      );
      return;
    }

    // Web frontends and the notification cache need the daemon-assigned
    // runtime identity for routing. Connector facades instead receive the
    // runtime's original string below, preserving the legacy event payload
    // byte-for-byte for idless notifications.
    const broadcastMessage = rewriteRuntimeClientId(message, clientId);
    this.memoizedNotificationQueryTable.recordNotification(
      clientId,
      broadcastMessage,
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

  sendMessageToApp(
    id: number,
    message: string,
    fromWebClientId?: number,
    controlId?: number,
  ): void {
    if (fromWebClientId !== undefined) {
      this.handleWebSocketMessage(fromWebClientId, id, message);
      return;
    }

    this.sendMessageToRuntime(id, message, {
      kind: "control",
      controlId: controlId ?? 0,
      clientId: id,
    });
  }

  rewriteOutboundMessage(message: string, target: PendingTargetSeed): string {
    const data = parseJsonMessage(message);
    this.rewriteOutboundMessageData(data, target);
    return JSON.stringify(data);
  }

  restoreInboundMessage(
    message: string,
    sourceClientId?: number,
  ): RoutedMessage | null {
    const data = parseJsonMessageOrNull(message);
    if (!data) {
      return null;
    }

    const customized = getCustomizedPayload(data);
    const globalMessageId = getValidMessageId(customized?.message);
    if (globalMessageId === null) {
      return null;
    }

    const pendingTarget = this.pendingRoutes.get(globalMessageId);
    if (
      pendingTarget &&
      sourceClientId !== undefined &&
      pendingTarget.clientId !== sourceClientId
    ) {
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
    const externalMessage = JSON.stringify(data);
    rewriteRuntimeClientIdData(data, target.clientId);

    return {
      target,
      clientId: target.clientId,
      message: JSON.stringify(data),
      externalMessage,
    };
  }

  private async connectDevices(
    params: ControlRpcParams["connectDevices"],
  ): Promise<DeviceSnapshot[]> {
    this.legacyOwnershipGuard.reacquire();
    const generation = this.physicalDiscoveryGeneration;
    await this.ensureDeviceDiscovery(
      params.isAutoListenClients ?? true,
      generation,
    );
    this.assertPhysicalDiscoveryCurrent(generation);
    return this.getDeviceSnapshots({
      timeout: params.timeout,
      serial: params.serial,
    });
  }

  private async getDeviceSnapshots(
    params: Pick<ControlRpcParams["connectDevices"], "timeout" | "serial">,
  ): Promise<DeviceSnapshot[]> {
    this.assertPhysicalDiscoveryCurrent(this.physicalDiscoveryGeneration);
    const devices = await this.physicalConnector.getDevices(
      params.timeout ?? -1,
      params.serial ?? null,
    );
    return this.serializeDevices(devices);
  }

  private async connectUsbClients(
    params: ControlRpcParams["connectUsbClients"],
  ): Promise<ClientSnapshot[]> {
    const generation = this.physicalDiscoveryGeneration;
    await this.ensureDeviceDiscovery(false, generation);
    await this.ensureClientDiscovery(params.deviceId, generation);
    this.assertPhysicalDiscoveryCurrent(generation);

    const clients = await this.getDeviceUsbClients(
      params.deviceId,
      params.timeout ?? -1,
      params.waitTimeout ?? true,
      params.clientName ?? null,
    );
    const snapshots = this.serializeClients(clients);
    this.publishClientSnapshot();
    return snapshots;
  }

  /**
   * Starts client discovery for one device without changing whether newly
   * discovered devices should be watched automatically.
   */
  private async startWatchClient(deviceId: string): Promise<void> {
    const generation = this.physicalDiscoveryGeneration;
    const clientWatchGeneration = this.clientWatchGeneration;
    await this.ensureDeviceDiscovery(false, generation);
    await this.ensureClientDiscovery(
      deviceId,
      generation,
      clientWatchGeneration,
    );
  }

  /**
   * Stops client discovery for one device. The device remains connected and
   * can be watched again through startWatchClient.
   */
  private async stopWatchClient(deviceId: string): Promise<void> {
    this.clearClientDiscoveryForDevice(deviceId);

    const device = this.physicalConnector.devices.get(deviceId);
    if (!device) {
      return;
    }

    await device.stopWatchClient();
  }

  private disconnectDevice(params: ControlRpcParams["disconnectDevice"]): void {
    this.clearClientDiscoveryForDevice(params.deviceId);

    const device = this.physicalConnector.devices.get(params.deviceId);
    if (!device) {
      return;
    }

    device.disConnect();
  }

  private async ensureDeviceDiscovery(
    isAutoListenClients: boolean = true,
    generation: number = this.physicalDiscoveryGeneration,
  ): Promise<void> {
    this.assertPhysicalDiscoveryCurrent(generation);
    if (!this.deviceDiscoveryStarted && !this.deviceDiscoveryStarting) {
      this.deviceDiscoveryStarting = this.physicalConnector
        .connectDevices(-1, null, false)
        .then(() => {
          if (this.isPhysicalDiscoveryCurrent(generation)) {
            this.deviceDiscoveryStarted = true;
          }
        })
        .finally(() => {
          if (this.isPhysicalDiscoveryCurrent(generation)) {
            this.deviceDiscoveryStarting = null;
          }
        });
    }

    if (this.deviceDiscoveryStarting) {
      await this.deviceDiscoveryStarting;
    }
    this.assertPhysicalDiscoveryCurrent(generation);
    if (isAutoListenClients) {
      await this.ensureAutoClientDiscovery(generation);
    }
  }

  private async ensureAutoClientDiscovery(
    generation: number = this.physicalDiscoveryGeneration,
  ): Promise<void> {
    this.assertPhysicalDiscoveryCurrent(generation);
    if (this.option.manualConnect) {
      return;
    }

    this.deviceDiscoveryAutoListensClients = true;
    await this.ensureClientDiscoveryForCurrentDevices(generation);
  }

  private async ensureClientDiscovery(
    deviceId: string,
    generation: number = this.physicalDiscoveryGeneration,
    clientWatchGeneration: number = this.clientWatchGeneration,
  ): Promise<void> {
    this.assertPhysicalDiscoveryCurrent(generation);
    if (clientWatchGeneration !== this.clientWatchGeneration) {
      return;
    }
    if (this.clientDiscoveryStartedDeviceIds.has(deviceId)) {
      return;
    }

    const existing = this.clientDiscoveryStartingByDeviceId.get(deviceId);
    if (existing) {
      await existing;
      return;
    }

    const starting = Promise.resolve()
      .then(async () => {
        this.assertPhysicalDiscoveryCurrent(generation);
        if (clientWatchGeneration !== this.clientWatchGeneration) {
          return;
        }
        const device = this.physicalConnector.devices.get(deviceId);
        if (!device) {
          return;
        }

        await this.physicalConnector.startWatchClient(
          device,
          () =>
            this.isPhysicalDiscoveryCurrent(generation) &&
            clientWatchGeneration === this.clientWatchGeneration,
        );
        if (
          this.isPhysicalDiscoveryCurrent(generation) &&
          clientWatchGeneration === this.clientWatchGeneration
        ) {
          this.clientDiscoveryStartedDeviceIds.add(deviceId);
        }
      })
      .finally(() => {
        if (
          this.isPhysicalDiscoveryCurrent(generation) &&
          this.clientDiscoveryStartingByDeviceId.get(deviceId) === starting
        ) {
          this.clientDiscoveryStartingByDeviceId.delete(deviceId);
        }
      });

    this.clientDiscoveryStartingByDeviceId.set(deviceId, starting);
    await starting;
  }

  private async getDeviceUsbClients(
    deviceId: string,
    timeout: number,
    waitTimeout: boolean,
    clientName: string | null,
  ): Promise<UsbClient[]> {
    if (!waitTimeout) {
      return this.physicalConnector.waitDeviceUsbClients(deviceId, timeout);
    }

    return this.physicalConnector.getDeviceUsbClients(
      deviceId,
      timeout,
      clientName,
    );
  }

  private async startWatchAllClients(
    _params: ControlRpcParams["startAllDeviceClientWatchers"],
  ): Promise<void> {
    this.legacyOwnershipGuard.reacquire();
    const generation = this.physicalDiscoveryGeneration;
    const clientWatchGeneration = this.clientWatchGeneration;
    this.assertPhysicalDiscoveryCurrent(generation);
    this.allClientWatchersRequested = true;
    await this.ensureDeviceDiscovery(false, generation);
    if (clientWatchGeneration !== this.clientWatchGeneration) {
      return;
    }
    await this.ensureClientDiscoveryForCurrentDevices(
      generation,
      clientWatchGeneration,
    );
    this.publishClientSnapshot();
  }

  /**
   * Stops every current client watcher and prevents both all-client and
   * connectDevices auto-watch modes from starting watchers for later devices.
   * Explicit watcher RPCs can enable discovery again.
   */
  private async stopWatchAllClients(
    _params: ControlRpcParams["stopAllDeviceClientWatchers"],
  ): Promise<void> {
    this.clientWatchGeneration++;
    this.allClientWatchersRequested = false;
    this.deviceDiscoveryAutoListensClients = false;

    await Promise.allSettled(
      Array.from(this.clientDiscoveryStartingByDeviceId.values()),
    );
    this.clientDiscoveryStartingByDeviceId.clear();
    this.clientDiscoveryStartedDeviceIds.clear();

    await Promise.all(
      Array.from(this.physicalConnector.devices.values(), (device) =>
        device.stopWatchClient(),
      ),
    );
    this.publishClientSnapshot();
  }

  private async startWSServer(
    controlId: number,
  ): Promise<WebSocketServerInfo> {
    if (!this.option.enableWebSocket) {
      throw createControlError(
        "websocket-disabled",
        "The multiplexer daemon does not support WebSocket because enableWebSocket is disabled",
      );
    }

    this.webSocketRequesterControlIds.add(controlId);

    try {
      if (this.webSocketServerStarted) {
        const info = this.webSocketServerInfo;
        if (!info) {
          throw createControlError(
            "websocket-server-info-unavailable",
            "The multiplexer daemon WebSocket server information is unavailable",
          );
        }
        this.sendSnapshotToControl(controlId);
        return info;
      }

      if (!this.webSocketServerStarting) {
        this.webSocketServerStarting = this.startWebSocketServerInternal()
          .then((info) => {
            this.webSocketServerStarted = true;
            this.webSocketServerInfo = info;
            this.connectionTraceRecorder?.recordWebsocketServerStarted(info);
            return info;
          })
          .finally(() => {
            this.webSocketServerStarting = null;
          });
      }

      const info = await this.webSocketServerStarting;
      if (this.webSocketRequesterControlIds.has(controlId)) {
        this.sendSnapshotToControl(controlId);
      }
      return info;
    } catch (error) {
      this.webSocketRequesterControlIds.delete(controlId);
      throw error;
    }
  }

  private recordWebsocketServerStopped(
    info: WebSocketServerInfo | undefined,
    reason: string,
  ): void {
    this.connectionTraceRecorder?.recordWebsocketServerStopped({
      port: info?.port,
      host: info?.host,
      roomId: info?.roomId,
      reason,
    });
  }

  private async startWebSocketServerInternal(): Promise<WebSocketServerInfo> {
    const port = this.option.websocketOption?.port ?? DEFAULT_DEV_SERVE_PORT;
    const wssPort = await detectPort(port);
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

  private async sendRawMessage(
    params: ControlRpcParams["sendMessageWithReply"],
    controlId: number,
  ): Promise<ResponseMessageType> {
    return new Promise<ResponseMessageType>((resolve, reject) => {
      try {
        this.sendMessageToRuntime(params.clientId, params.message, {
          kind: "control",
          controlId,
          clientId: params.clientId,
          resolve: (value) => resolve(value as ResponseMessageType),
          reject,
        });
      } catch (error) {
        reject(error);
      }
    });
  }

  private getUsbClient(clientId: number): UsbClient {
    const client = this.physicalConnector.usbClients.get(clientId);
    if (!client) {
      throw createControlError(
        "multiplexer-client-not-found",
        `Multiplexer USB client was not found: ${clientId}`,
      );
    }

    return client;
  }

  private getWebSocketAppClients(): Map<number, WebSocketClient> | undefined {
    return this.webSocketController?.getAllWebsocketAppClients?.();
  }

  private getWebSocketWebClients(): Map<number, WebSocketClient> | undefined {
    return this.webSocketController?.getAllWebsocketWebClients?.();
  }

  private getWebSocketRuntimeClient(
    clientId: number,
  ): WebSocketClient | undefined {
    return this.getWebSocketAppClients()?.get(clientId);
  }

  private sendMessageFromConnector(
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
      controlId,
      clientId: params.clientId,
    });
  }

  private closeClient(clientId: number): void {
    const websocketClient = this.getWebSocketRuntimeClient(clientId);
    if (websocketClient) {
      websocketClient.close();
      return;
    }
    this.physicalConnector.closeClient(clientId);
  }

  private serializeDevice(device: BaseDevice): DeviceSnapshot {
    const info: DeviceDescription = device.info;
    const host = safeGetDeviceHost(device);
    const snapshot: DeviceSnapshot = {
      os: info.os,
      title: info.title,
      serial: info.serial,
      ports: [...device.ports],
    };

    if (host !== undefined) {
      snapshot.host = host;
    }

    return snapshot;
  }

  private serializeClient(client: UsbClient): ClientSnapshot {
    const info: ClientDescription = client.info;
    const rawInfo = cloneJsonValue(info.query.raw_info);
    const query = {
      app: info.query.app,
      os: info.query.os,
      device: info.query.device,
      device_model: info.query.device_model,
      device_id: info.query.device_id,
      sdk_version: info.query.sdk_version,
      raw_info: rawInfo,
    };

    if (query.sdk_version === undefined) {
      delete query.sdk_version;
    }
    if (query.raw_info === undefined) {
      delete query.raw_info;
    }

    return {
      port: info.port,
      id: info.id,
      query,
    };
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

  private createPhysicalConnector(): PhysicalConnector {
    if (this.option.physicalConnector && !this.option.PhysicalConnectorCtor) {
      return this.option.physicalConnector;
    }

    const PhysicalConnectorCtor =
      this.option.PhysicalConnectorCtor ?? PhysicalConnector;
    return new PhysicalConnectorCtor({
      ...this.option,
      traceRecorder: this.connectionTraceRecorder,
    });
  }

  private async ensureClientDiscoveryForCurrentDevices(
    generation: number = this.physicalDiscoveryGeneration,
    clientWatchGeneration: number = this.clientWatchGeneration,
  ): Promise<void> {
    this.assertPhysicalDiscoveryCurrent(generation);
    const deviceIds = Array.from(this.physicalConnector.devices.keys());
    await Promise.all(
      deviceIds.map((deviceId) =>
        this.ensureClientDiscovery(deviceId, generation, clientWatchGeneration),
      ),
    );
  }

  private clearClientDiscoveryForDevice(deviceId: string): void {
    this.clientDiscoveryStartedDeviceIds.delete(deviceId);
    this.clientDiscoveryStartingByDeviceId.delete(deviceId);
  }

  private resetDiscoveryState(): void {
    this.physicalDiscoveryGeneration++;
    this.legacyOwnershipAttached = false;
    this.deviceDiscoveryStarted = false;
    this.deviceDiscoveryStarting = null;
    this.deviceDiscoveryAutoListensClients = false;
    this.clientDiscoveryStartedDeviceIds.clear();
    this.clientDiscoveryStartingByDeviceId.clear();
    this.allClientWatchersRequested = false;
    this.webSocketServerStarted = false;
    this.webSocketServerStarting = null;
    this.activeControlIds.clear();
    this.webSocketRequesterControlIds.clear();
    this.activeWebSocketDriverIds.clear();
    this.clearIdleTimeout();
    this.memoizedNotificationQueryTable.clear();
    this.rejectRoutes(
      this.pendingRoutes.clear(),
      new Error("Multiplexer host route table was reset"),
    );
  }

  private publishClientSnapshot(): void {
    this.webSocketController?.sendClientList();
    this.publishSnapshot();
  }

  private handleLegacyOwnershipLost(): void {
    this.legacyOwnershipAttached = false;
    this.resetPhysicalDiscoveryState(
      new Error("Multiplexer legacy owner was preempted"),
    );
    this.physicalConnector.disableAllClients();
    this.physicalConnector.usbClients.clear();
    this.physicalConnector.selectedClient = undefined;
    this.webSocketController?.closeAllWebsocketAppClients?.();
    this.publishSnapshot();
    this.webSocketController?.sendDeviceList();
    this.webSocketController?.sendClientList();
  }

  private resetPhysicalDiscoveryState(error: Error): void {
    this.physicalDiscoveryGeneration++;
    this.deviceDiscoveryStarted = false;
    this.deviceDiscoveryStarting = null;
    this.deviceDiscoveryAutoListensClients = false;
    this.clientDiscoveryStartedDeviceIds.clear();
    this.clientDiscoveryStartingByDeviceId.clear();
    this.allClientWatchersRequested = false;
    this.memoizedNotificationQueryTable.clear();
    this.rejectRoutes(this.pendingRoutes.clear(), error);
  }

  private isPhysicalDiscoveryCurrent(generation: number): boolean {
    return (
      this.legacyOwnershipAttached &&
      this.physicalDiscoveryGeneration === generation
    );
  }

  private assertPhysicalDiscoveryCurrent(generation: number): void {
    if (!this.isPhysicalDiscoveryCurrent(generation)) {
      throw new Error("Multiplexer legacy owner is not attached");
    }
  }

  private sendMessageToRuntime(
    clientId: number,
    message: string | object,
    target: PendingTargetSeed,
  ): void {
    const websocketClient = this.getWebSocketAppClients()?.get(clientId);
    const usbClient = this.physicalConnector.usbClients.get(clientId);
    if (!websocketClient && !usbClient) {
      throw createControlError(
        "multiplexer-client-not-found",
        `Multiplexer client was not found: ${clientId}`,
      );
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

    const memoizedQuery = this.memoizedNotificationQueryTable.query(
      clientId,
      data,
    );
    if (memoizedQuery.action === "cached") {
      this.sendMessageToTarget(target, clientId, memoizedQuery.message);
      return;
    }
    if (memoizedQuery.action === "pending") {
      return;
    }

    const route = this.rewriteOutboundMessageData(data, target);
    try {
      if (websocketClient) {
        websocketClient.sendMessage(JSON.stringify(data));
      } else {
        usbClient!.sendMessage(data);
      }
    } catch (error) {
      if (memoizedQuery.action === "forward") {
        this.memoizedNotificationQueryTable.handleSendFailure(
          clientId,
          memoizedQuery.requestType,
        );
      }
      if (route) {
        this.pendingRoutes.delete(route.globalMessageId);
      }
      throw error;
    }
  }

  private sendMessageToTarget(
    target: PendingTargetSeed,
    clientId: number,
    message: string,
  ): void {
    if (target.kind === "control") {
      if (target.resolve) {
        target.resolve(parseRawResponse(message, clientId));
        return;
      }
      this.sendToControl(target.controlId, {
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

    this.sendMessageToWebClient(target.webClientId, message);
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

    const globalMessageId = this.createGlobalMessageId();
    const route = this.pendingRoutes.add(globalMessageId, {
      ...target,
      originalId,
      clientId: target.clientId,
    });

    customized.message.id = globalMessageId;
    writeCustomizedMessage(customized);
    return route;
  }

  private createGlobalMessageId(): number {
    while (this.pendingRoutes.has(this.nextGlobalMessageId)) {
      this.nextGlobalMessageId++;
    }
    if (this.nextGlobalMessageId >= Number.MAX_SAFE_INTEGER) {
      this.nextGlobalMessageId = 1;
    }
    return this.nextGlobalMessageId++;
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

  private rejectRoutes(routes: PendingRoute[], error: Error): void {
    for (const route of routes) {
      if (route.kind === "control") {
        route.reject?.(error);
      }
    }
  }

  private requestDaemonShutdown(reason?: string): void {
    if (!this.shutdownHandler) {
      throw createControlError(
        "daemon-shutdown-unavailable",
        "Multiplexer daemon shutdown handler is not configured",
      );
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
    setImmediate(() => {
      void shutdownHandler();
    });
  }

  private scheduleIdleTimeoutIfNeeded(): void {
    if (!this.started || !this.idleTimeoutHandler) {
      return;
    }

    const idleTimeout = this.getIdleTimeout();
    if (idleTimeout === undefined || !this.isIdle()) {
      return;
    }

    this.clearIdleTimeout();
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (!this.isIdle()) {
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

  private isIdle(): boolean {
    return (
      this.activeControlIds.size === 0 &&
      this.activeWebSocketDriverIds.size === 0
    );
  }

  private getIdleTimeout(): number | undefined {
    const idleTimeout =
      this.runtimeIdleTimeout ?? this.option.multiplexerDaemonIdleTimeout;
    if (
      idleTimeout === undefined ||
      !Number.isFinite(idleTimeout) ||
      idleTimeout < 0
    ) {
      return undefined;
    }

    return idleTimeout;
  }
}

function createControlError(
  code: string,
  message: string,
  details?: unknown,
): ControlRpcError {
  return {
    code,
    message,
    details,
  };
}

function createStopError(errors: unknown[]): Error {
  const message = errors
    .map((error) => (error instanceof Error ? error.message : String(error)))
    .join("; ");
  const stopError = new Error(`Failed to stop multiplexer host: ${message}`);
  (stopError as any).errors = errors;
  return stopError;
}

function safeGetDeviceHost(device: BaseDevice): string | undefined {
  try {
    return device.getHost();
  } catch (error: any) {
    defaultLogger.warn(
      `Failed to serialize multiplexer device host: ${error?.message}`,
    );
    return undefined;
  }
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
    throw createControlError(
      "invalid-json-message",
      `Invalid JSON message for multiplexer app client: ${error?.message}`,
    );
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
  if (typeof rawMessage === "string") {
    const message = parseJsonMessageOrNull(rawMessage);
    if (!message) {
      return null;
    }

    return {
      container,
      message,
      messageWasString: true,
    };
  }

  if (typeof rawMessage === "object" && rawMessage !== null) {
    return {
      container,
      message: rawMessage,
      messageWasString: false,
    };
  }

  return null;
}

function writeCustomizedMessage(payload: CustomizedPayload): void {
  payload.container.message = payload.messageWasString
    ? JSON.stringify(payload.message)
    : payload.message;
}

function getValidMessageId(message: any | null | undefined): number | null {
  const id = message?.id;
  if (!Number.isSafeInteger(id)) {
    return null;
  }

  return id;
}

function hasResponseId(message: string): boolean {
  const data = parseJsonMessageOrNull(message);
  if (!data) {
    return false;
  }

  const customized = getCustomizedPayload(data);
  return getValidMessageId(customized?.message) !== null;
}

function parseRawResponse(
  message: string,
  clientId: number,
): ResponseMessageType {
  const data = parseJsonMessage(message);
  if (
    data?.data?.data &&
    Object.prototype.hasOwnProperty.call(data.data.data, "client_id")
  ) {
    data.data.data.client_id = clientId;
  }
  if (
    data?.data?.data &&
    Object.prototype.hasOwnProperty.call(data.data.data, "message") &&
    typeof data.data.data.message !== "string"
  ) {
    data.data.data.message = JSON.stringify(data.data.data.message);
  }
  return data as ResponseMessageType;
}

function rewriteRuntimeClientId(message: string, clientId: number): string {
  const data = parseJsonMessageOrNull(message);
  if (!data) {
    return message;
  }

  rewriteRuntimeClientIdData(data, clientId);
  return JSON.stringify(data);
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

function isWebSocketDriverType(type?: string): boolean {
  return type === "Driver";
}

function isMultiplexerHostStartOption(
  option: unknown,
): option is MultiplexerHostStartOption {
  return typeof option === "object" && option !== null;
}
