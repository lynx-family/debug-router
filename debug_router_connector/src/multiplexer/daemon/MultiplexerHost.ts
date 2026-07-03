// Copyright 2024 The Lynx Authors. All rights reserved.
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
import {
  SocketEvent,
  ClientDescription,
  DeviceDescription,
  PhysicalConnectorEvent,
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
  Snapshot,
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
import { PendingRoute, PendingRouteTable } from "./PendingRouteTable";

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
  close(): void;
};

export type MultiplexerHostOption = PhysicalConnectorOption & {
  controlPort?: number;
  protocolVersion?: number;
  minSupportedProtocolVersion?: number;
  daemonVersion?: string;
  capabilities?: string[];
  legacyDriverDir?: string;
  multiplexerDaemonIdleTimeout?: number;
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
  private readonly option: MultiplexerHostOption;
  private readonly protocolVersion: number;
  private readonly minSupportedProtocolVersion: number;
  private readonly now: () => number;
  private readonly pendingRoutes: PendingRouteTable;
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
  private webSocketServerStarting: Promise<void> | null = null;
  private readonly activeControlIds = new Set<number>();
  private readonly activeWebSocketDriverIds = new Set<number>();
  private readonly legacyOwnershipGuard: LegacyOwnershipGuard;
  private physicalDiscoveryGeneration = 0;
  private legacyOwnershipAttached = false;
  private idleTimer: NodeJS.Timeout | null = null;
  private idleTimeoutHandler: (() => void | Promise<void>) | undefined;
  private shutdownHandler: (() => void | Promise<void>) | undefined;
  private runtimeIdleTimeout: number | undefined;
  private nextGlobalMessageId = 1;
  private nextControlMessageId = 1;
  private started = false;
  private shutdownRequested = false;

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

    this.broadcast({
      kind: "event",
      event: "device-connected",
      data: this.serializeDevice(device),
    });
    this.webSocketController?.sendDeviceList();
    this.publishSnapshot();
  };

  private readonly handleDeviceDisconnected = (device: BaseDevice): void => {
    if (!this.legacyOwnershipAttached) {
      return;
    }

    this.clearClientDiscoveryForDevice(device.serial);

    this.broadcast({
      kind: "event",
      event: "device-disconnected",
      data: {
        serial: device.serial,
      },
    });
    this.webSocketController?.sendDeviceList();
    this.publishSnapshot();
  };

  private readonly handleClientConnected = (client: UsbClient): void => {
    if (!this.legacyOwnershipAttached) {
      return;
    }

    this.broadcast({
      kind: "event",
      event: "client-connected",
      data: this.serializeClient(client),
    });
    this.webSocketController?.sendClientList();
    this.publishSnapshot();
  };

  private readonly handleClientDisconnected = (id: number): void => {
    if (!this.legacyOwnershipAttached) {
      return;
    }

    this.broadcast({
      kind: "event",
      event: "client-disconnected",
      data: {
        id,
      },
    });
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
      this.handleLegacyOwnershipLost();
    } else {
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
      daemonVersion: this.option.daemonVersion,
      capabilities: this.option.capabilities,
      now: this.now,
    });

    this.controlServer = controlServer;

    try {
      await controlServer.start();
      this.started = true;
      this.legacyOwnershipGuard.start();
      this.scheduleIdleTimeoutIfNeeded();
    } catch (error) {
      await this.stop();
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (!this.started && !this.controlServer && !this.webSocketController) {
      return;
    }

    const stopErrors: unknown[] = [];
    this.started = false;
    this.shutdownRequested = false;
    this.clearIdleTimeout();
    this.legacyOwnershipGuard.stop();
    this.activeControlIds.clear();
    this.activeWebSocketDriverIds.clear();
    this.unbindPhysicalConnectorEvents();

    const webSocketController = this.webSocketController;
    this.webSocketController = null;
    this.webSocketServerInfo = undefined;
    this.webSocketServerStarted = false;
    this.webSocketServerStarting = null;
    try {
      webSocketController?.close();
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
    this.clearIdleTimeout();
    this.sendToControl(controlId, {
      kind: "event",
      event: "snapshot",
      data: this.createSnapshot(),
    });
  }

  handleControlDisconnected(controlId: number): void {
    this.activeControlIds.delete(controlId);
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
      case "getDevices":
        return this.getDeviceSnapshots(
          message.params as ControlRpcParams["getDevices"],
        );
      case "connectUsbClients":
        return this.connectUsbClients(
          message.params as ControlRpcParams["connectUsbClients"],
        );
      case "startWatchClient":
        return this.startWatchClient(
          message.params as ControlRpcParams["startWatchClient"],
        );
      case "stopWatchClient":
        return this.stopWatchClient(
          message.params as ControlRpcParams["stopWatchClient"],
        );
      case "disconnectDevice":
        return this.disconnectDevice(
          message.params as ControlRpcParams["disconnectDevice"],
        );
      case "reacquireLegacyOwnership":
        return this.reacquireLegacyOwnership();
      case "shutdownDaemon":
        this.requestDaemonShutdown();
        return undefined;
      case "startWSServer":
        return this.startWSServer();
      case "startWatchAllClients":
        return this.startWatchAllClients(
          message.params as ControlRpcParams["startWatchAllClients"],
        );
      case "sendMessageToWeb":
        return this.sendMessageToWeb(
          (message.params as ControlRpcParams["sendMessageToWeb"]).message,
        );
      case "sendMessageToApp":
        return this.sendMessageToApp(
          (message.params as ControlRpcParams["sendMessageToApp"]).id,
          (message.params as ControlRpcParams["sendMessageToApp"]).message,
          (message.params as ControlRpcParams["sendMessageToApp"])
            .fromWebClientId,
          controlId,
        );
      case "sendCustomizedMessage":
        return this.sendCustomizedMessage(
          message.params as ControlRpcParams["sendCustomizedMessage"],
          controlId,
        );
      case "sendRawMessage":
        return this.physicalConnector.sendRawMessage(
          (message.params as ControlRpcParams["sendRawMessage"]).clientId,
          (message.params as ControlRpcParams["sendRawMessage"]).message,
        );
      case "sendMessage":
        this.physicalConnector.sendMessage(
          (message.params as ControlRpcParams["sendMessage"]).clientId,
          (message.params as ControlRpcParams["sendMessage"]).message,
        );
        return undefined;
      case "closeClient":
        this.physicalConnector.closeClient(
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

  sendToControl(controlId: number, event: ControlEvent): void {
    this.controlServer?.sendToControl(controlId, event);
  }

  publishSnapshot(snapshot: Snapshot = this.createSnapshot()): void {
    this.broadcast({
      kind: "event",
      event: "snapshot",
      data: snapshot,
    });
  }

  createSnapshot(): Snapshot {
    return {
      protocolVersion: this.protocolVersion,
      generatedAt: this.now(),
      devices: this.serializeDevices(
        Array.from(this.physicalConnector.devices.values()),
      ),
      clients: this.serializeClients(this.physicalConnector.getAllUsbClients()),
      daemonVersion: this.option.daemonVersion,
      capabilities: this.option.capabilities
        ? [...this.option.capabilities]
        : undefined,
    };
  }

  createEmptySnapshot(): Snapshot {
    return {
      protocolVersion: this.protocolVersion,
      generatedAt: this.now(),
      devices: [],
      clients: [],
      daemonVersion: this.option.daemonVersion,
      capabilities: this.option.capabilities
        ? [...this.option.capabilities]
        : undefined,
    };
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
    // Runtime message through WebSocket
    this.handlePhysicalMessage(appClientId, message);
  }

  handleWebSocketClientConnected(clientId: number, type?: string): void {
    if (isWebSocketDriverType(type)) {
      this.activeWebSocketDriverIds.add(clientId);
      this.clearIdleTimeout();
    }
  }

  handleWebSocketClientDisconnected(clientId: number, type?: string): void {
    if (isWebSocketDriverType(type)) {
      this.activeWebSocketDriverIds.delete(clientId);
    }
    this.pendingRoutes.clearByWebClientId(clientId);
    this.scheduleIdleTimeoutIfNeeded();
  }

  handlePhysicalMessage(clientId: number, message: string): void {
    const routed = this.restoreInboundMessage(message);
    if (routed) {
      if (routed.target.kind === "control") {
        if (routed.target.resolve) {
          routed.target.resolve(extractCustomizedMessage(routed.message));
        } else {
          this.sendToControl(routed.target.controlId, {
            kind: "event",
            event: "usb-client-message",
            data: {
              id: routed.clientId,
              message: routed.message,
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

    const broadcastMessage = rewriteRuntimeClientId(message, clientId);
    if (this.option.enableWebSocket) {
      this.sendMessageToWeb(broadcastMessage);
    }
    this.broadcast({
      kind: "event",
      event: "usb-client-message",
      data: {
        id: clientId,
        message: broadcastMessage,
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

  restoreInboundMessage(message: string): RoutedMessage | null {
    const data = parseJsonMessageOrNull(message);
    if (!data) {
      return null;
    }

    const customized = getCustomizedPayload(data);
    const globalMessageId = getValidMessageId(customized?.message);
    if (globalMessageId === null) {
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
    rewriteRuntimeClientIdData(data, target.clientId);

    return {
      target,
      clientId: target.clientId,
      message: JSON.stringify(data),
    };
  }

  private async connectDevices(
    params: ControlRpcParams["connectDevices"],
  ): Promise<DeviceSnapshot[]> {
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
    params: ControlRpcParams["getDevices"],
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

  private async startWatchClient(
    params: ControlRpcParams["startWatchClient"],
  ): Promise<void> {
    const generation = this.physicalDiscoveryGeneration;
    await this.ensureDeviceDiscovery(false, generation);
    await this.ensureClientDiscovery(params.deviceId, generation);
  }

  private async stopWatchClient(
    params: ControlRpcParams["stopWatchClient"],
  ): Promise<void> {
    this.clearClientDiscoveryForDevice(params.deviceId);

    const device = this.physicalConnector.devices.get(params.deviceId);
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

  private reacquireLegacyOwnership(): void {
    this.legacyOwnershipGuard.reacquire();
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
  ): Promise<void> {
    this.assertPhysicalDiscoveryCurrent(generation);
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
        const device = this.physicalConnector.devices.get(deviceId);
        if (!device) {
          return;
        }

        await this.physicalConnector.startWatchClient(device, () =>
          this.isPhysicalDiscoveryCurrent(generation),
        );
        if (this.isPhysicalDiscoveryCurrent(generation)) {
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
    params: ControlRpcParams["startWatchAllClients"],
  ): Promise<void> {
    const generation = this.physicalDiscoveryGeneration;
    this.assertPhysicalDiscoveryCurrent(generation);
    this.allClientWatchersRequested = true;
    await this.ensureDeviceDiscovery(false, generation);
    await this.ensureClientDiscoveryForCurrentDevices(generation);
    this.publishClientSnapshot();
  }

  private async startWSServer(): Promise<WebSocketServerInfo | undefined> {
    if (!this.option.enableWebSocket) {
      return;
    }

    if (this.webSocketServerStarted) {
      return this.webSocketServerInfo;
    }

    if (!this.webSocketServerStarting) {
      this.webSocketServerStarting = this.startWebSocketServerInternal()
        .then((info) => {
          this.webSocketServerStarted = true;
          this.webSocketServerInfo = info;
        })
        .finally(() => {
          this.webSocketServerStarting = null;
        });
    }

    await this.webSocketServerStarting;
    return this.webSocketServerInfo;
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

  private createControlMessageId(): number {
    while (this.pendingRoutes.has(this.nextControlMessageId)) {
      this.nextControlMessageId++;
    }
    if (this.nextControlMessageId >= Number.MAX_SAFE_INTEGER) {
      this.nextControlMessageId = 1;
    }
    return this.nextControlMessageId++;
  }

  private async sendCustomizedMessage(
    params: ControlRpcParams["sendCustomizedMessage"],
    controlId: number,
  ): Promise<string> {
    const originalId = this.createControlMessageId();
    const message = createCustomizedMessage({
      id: originalId,
      method: params.method,
      params: normalizeCustomizedParams(params.params),
      sessionId: params.sessionId ?? -1,
      type: params.type ?? "CDP",
    });

    return new Promise<string>((resolve, reject) => {
      try {
        this.sendMessageToRuntime(params.clientId, message, {
          kind: "control",
          controlId,
          clientId: params.clientId,
          resolve: (value) => resolve(String(value)),
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
    return new PhysicalConnectorCtor(this.option);
  }

  private canRecreatePhysicalConnector(): boolean {
    return (
      !this.option.physicalConnector ||
      this.option.PhysicalConnectorCtor !== undefined
    );
  }

  private async ensureClientDiscoveryForCurrentDevices(
    generation: number = this.physicalDiscoveryGeneration,
  ): Promise<void> {
    this.assertPhysicalDiscoveryCurrent(generation);
    const deviceIds = Array.from(this.physicalConnector.devices.keys());
    await Promise.all(
      deviceIds.map((deviceId) =>
        this.ensureClientDiscovery(deviceId, generation),
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
    this.activeWebSocketDriverIds.clear();
    this.clearIdleTimeout();
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
    const oldPhysicalConnector = this.physicalConnector;
    this.unbindPhysicalConnectorEvents();
    oldPhysicalConnector.disableAllClients();
    oldPhysicalConnector.devices.clear();
    oldPhysicalConnector.usbClients.clear();
    oldPhysicalConnector.selectedClient = undefined;
    if (this.canRecreatePhysicalConnector()) {
      this.physicalConnector = this.createPhysicalConnector();
      this.bindPhysicalConnectorEvents();
      void oldPhysicalConnector.close().catch((error: any) => {
        defaultLogger.warn(
          `Failed to close preempted physical connector: ${error?.message}`,
        );
      });
    } else {
      this.bindPhysicalConnectorEvents();
    }
    this.publishSnapshot(this.createEmptySnapshot());
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
    const client = this.getUsbClient(clientId);
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
      data.data.data.client_id = -1;
    }

    const route = this.rewriteOutboundMessageData(data, target);
    try {
      client.sendMessage(data);
    } catch (error) {
      if (route) {
        this.pendingRoutes.delete(route.globalMessageId);
      }
      throw error;
    }
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

  private rejectRoutes(routes: PendingRoute[], error: Error): void {
    for (const route of routes) {
      if (route.kind === "control") {
        route.reject?.(error);
      }
    }
  }

  private requestDaemonShutdown(): void {
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

function normalizeCustomizedParams(
  params: ControlRpcParams["sendCustomizedMessage"]["params"],
): Object {
  if (params === undefined) {
    return "";
  }

  return params as Object;
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

function createCustomizedMessage(option: {
  id: number;
  method: string;
  params: Object;
  sessionId: number;
  type: string;
}): object {
  return {
    event: SocketEvent.Customized,
    data: {
      type: option.type,
      data: {
        client_id: -1,
        session_id: option.sessionId,
        message: {
          id: option.id,
          method: option.method,
          params: option.params,
        },
      },
      sender: 0,
    },
  };
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

function extractCustomizedMessage(message: string): string {
  const data = parseJsonMessageOrNull(message);
  const customized = data ? getCustomizedPayload(data) : null;
  if (!customized) {
    return message;
  }

  return typeof customized.container.message === "string"
    ? customized.container.message
    : JSON.stringify(customized.container.message);
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
