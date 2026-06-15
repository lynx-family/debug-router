// Copyright 2024 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

import { BaseDevice } from "../../device/BaseDevice";
import {
  PhysicalConnector,
  PhysicalConnectorOption,
} from "../../physical/PhysicalConnector";
import { UsbClient } from "../../usb/Client";
import { defaultLogger } from "../../utils/logger";
import {
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
} from "../protocol";
import { MultiplexerDaemonHost } from "./MultiplexerDaemon";
import {
  MultiplexerControlHost,
  MultiplexerControlServer,
} from "./MultiplexerControlServer";

export type MultiplexerHostOption = PhysicalConnectorOption & {
  controlPort?: number;
  protocolVersion?: number;
  minSupportedProtocolVersion?: number;
  daemonVersion?: string;
  capabilities?: string[];
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

export class MultiplexerHost
  implements MultiplexerDaemonHost, MultiplexerControlHost {
  private readonly physicalConnector: PhysicalConnector;
  private readonly option: MultiplexerHostOption;
  private readonly protocolVersion: number;
  private readonly minSupportedProtocolVersion: number;
  private readonly now: () => number;
  private controlServer: MultiplexerControlServer | null = null;
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
  private started = false;

  private readonly handleDeviceConnected = (device: BaseDevice): void => {
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
    this.publishSnapshot();
  };

  private readonly handleDeviceDisconnected = (device: BaseDevice): void => {
    this.clearClientDiscoveryForDevice(device.serial);

    this.broadcast({
      kind: "event",
      event: "device-disconnected",
      data: {
        serial: device.serial,
      },
    });
    this.publishSnapshot();
  };

  private readonly handleClientConnected = (client: UsbClient): void => {
    this.broadcast({
      kind: "event",
      event: "client-connected",
      data: this.serializeClient(client),
    });
    this.publishSnapshot();
  };

  private readonly handleClientDisconnected = (id: number): void => {
    this.broadcast({
      kind: "event",
      event: "client-disconnected",
      data: {
        id,
      },
    });
    this.publishSnapshot();
  };

  private readonly handleUsbClientMessage = (
    payload: PhysicalConnectorEvent["usb-client-message"],
  ): void => {
    this.broadcast({
      kind: "event",
      event: "usb-client-message",
      data: {
        id: payload.id,
        message: payload.message,
      },
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

    const PhysicalConnectorCtor =
      option.PhysicalConnectorCtor ?? PhysicalConnector;
    this.physicalConnector =
      option.physicalConnector ?? new PhysicalConnectorCtor(option);
  }

  async start(): Promise<void> {
    if (this.started) {
      return;
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
    } catch (error) {
      await this.stop();
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (!this.started && !this.controlServer) {
      return;
    }

    this.started = false;
    this.unbindPhysicalConnectorEvents();

    const controlServer = this.controlServer;
    this.controlServer = null;
    if (controlServer) {
      await controlServer.stop();
    }

    await this.physicalConnector.close();
    this.resetDiscoveryState();
  }

  getControlPort(): number {
    return this.controlServer?.controlPort ?? this.option.controlPort ?? 0;
  }

  handleControlConnected(controlId: number): void {
    this.sendToControl(controlId, {
      kind: "event",
      event: "snapshot",
      data: this.createSnapshot(),
    });
  }

  handleControlDisconnected(_controlId: number): void {
    // Route cleanup for WebSocket/frontend traffic belongs to phase 6.
  }

  async handleControlRpc(
    _controlId: number,
    message: ControlRpcRequest,
  ): Promise<unknown> {
    switch (message.method) {
      case "connectDevices":
        return this.connectDevices(
          message.params as ControlRpcParams["connectDevices"],
        );
      case "getDevices":
        return this.getDevices(message.params as ControlRpcParams["getDevices"]);
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
      case "startWSServer":
        return this.startWSServer();
      case "startWatchAllClients":
        return this.startWatchAllClients(
          message.params as ControlRpcParams["startWatchAllClients"],
        );
      case "sendMessageToWeb":
        return this.sendMessageToWeb(
          message.params as ControlRpcParams["sendMessageToWeb"],
        );
      case "sendMessageToApp":
        return this.sendMessageToApp(
          message.params as ControlRpcParams["sendMessageToApp"],
        );
      case "sendCustomizedMessage":
        return this.sendCustomizedMessage(
          message.params as ControlRpcParams["sendCustomizedMessage"],
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
          `Unknown multiplexer control RPC: ${(message as ControlRpcRequest).method}`,
        );
    }
  }

  broadcast(event: ControlEvent): void {
    this.controlServer?.broadcast(event);
  }

  sendToControl(controlId: number, event: ControlEvent): void {
    this.controlServer?.sendToControl(controlId, event);
  }

  publishSnapshot(): void {
    this.broadcast({
      kind: "event",
      event: "snapshot",
      data: this.createSnapshot(),
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

  serializeDevices(devices: BaseDevice[]): DeviceSnapshot[] {
    return devices.map((device) => this.serializeDevice(device));
  }

  serializeClients(clients: UsbClient[]): ClientSnapshot[] {
    return clients.map((client) => this.serializeClient(client));
  }

  private async connectDevices(
    params: ControlRpcParams["connectDevices"],
  ): Promise<DeviceSnapshot[]> {
    await this.ensureDeviceDiscovery(params.isAutoListenClients ?? true);
    return this.getDevices({
      timeout: params.timeout,
      serial: params.serial,
    });
  }

  private async getDevices(
    params: ControlRpcParams["getDevices"],
  ): Promise<DeviceSnapshot[]> {
    const devices = await this.physicalConnector.getDevices(
      params.timeout ?? -1,
      params.serial ?? null,
    );
    return this.serializeDevices(devices);
  }

  private async connectUsbClients(
    params: ControlRpcParams["connectUsbClients"],
  ): Promise<ClientSnapshot[]> {
    await this.ensureDeviceDiscovery(false);
    await this.ensureClientDiscovery(params.deviceId);

    const clients = await this.getDeviceUsbClients(
      params.deviceId,
      params.timeout ?? -1,
      params.waitTimeout ?? true,
      params.clientName ?? null,
    );
    const snapshots = this.serializeClients(clients);
    return snapshots;
  }

  private async startWatchClient(
    params: ControlRpcParams["startWatchClient"],
  ): Promise<void> {
    await this.ensureDeviceDiscovery(false);
    await this.ensureClientDiscovery(params.deviceId);
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

  private disconnectDevice(
    params: ControlRpcParams["disconnectDevice"],
  ): void {
    this.clearClientDiscoveryForDevice(params.deviceId);

    const device = this.physicalConnector.devices.get(params.deviceId);
    if (!device) {
      return;
    }

    device.disConnect();
  }

  private async ensureDeviceDiscovery(
    isAutoListenClients: boolean = true,
  ): Promise<void> {
    if (!this.deviceDiscoveryStarted && !this.deviceDiscoveryStarting) {
      this.deviceDiscoveryStarting = this.physicalConnector
        .connectDevices(-1, null, false)
        .then(() => {
          this.deviceDiscoveryStarted = true;
        })
        .finally(() => {
          this.deviceDiscoveryStarting = null;
        });
    }

    if (this.deviceDiscoveryStarting) {
      await this.deviceDiscoveryStarting;
    }
    if (isAutoListenClients) {
      await this.ensureAutoClientDiscovery();
    }
  }

  private async ensureAutoClientDiscovery(): Promise<void> {
    if (this.option.manualConnect) {
      return;
    }

    this.deviceDiscoveryAutoListensClients = true;
    await this.ensureClientDiscoveryForCurrentDevices();
  }

  private async ensureClientDiscovery(deviceId: string): Promise<void> { 
    if (this.clientDiscoveryStartedDeviceIds.has(deviceId)) {
      return;
    }

    const existing = this.clientDiscoveryStartingByDeviceId.get(deviceId);
    if (existing) {
      await existing;
      return;
    }

    const starting = Promise.resolve()
      .then(() => {
        const device = this.physicalConnector.devices.get(deviceId);
        if (!device) {
          return;
        }
        
        this.physicalConnector.startWatchClient(device);
        this.clientDiscoveryStartedDeviceIds.add(deviceId);
      })
      .finally(() => {
        if (this.clientDiscoveryStartingByDeviceId.get(deviceId) === starting) {
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
    this.allClientWatchersRequested = true;
    await this.ensureDeviceDiscovery(false);
    await this.ensureClientDiscoveryForCurrentDevices();
  }

  private async startWSServer(): Promise<void> {
    if (!this.option.enableWebSocket) {
      return;
    }

    if (this.webSocketServerStarted) {
      return;
    }

    if (!this.webSocketServerStarting) {
      this.webSocketServerStarting = this.startWebSocketServerInternal()
        .then(() => {
          this.webSocketServerStarted = true;
        })
        .finally(() => {
          this.webSocketServerStarting = null;
        });
    }

    await this.webSocketServerStarting;
  }

  private async startWebSocketServerInternal(): Promise<void> {
    throw createControlError(
      "multiplexer-websocket-not-ready",
      "Multiplexer WebSocket frontend routing will be implemented in phase 6",
    );
  }

  private sendMessageToWeb(
    params: ControlRpcParams["sendMessageToWeb"],
  ): void {
    if (!this.option.enableWebSocket) {
      defaultLogger.warn("enableWebSocket isn't opened!");
      return;
    }

    throw createControlError(
      "multiplexer-websocket-not-ready",
      `Multiplexer cannot send message to Web before phase 6 routing is ready: ${params.message}`,
    );
  }

  private sendMessageToApp(
    params: ControlRpcParams["sendMessageToApp"],
  ): void {
    const client = this.physicalConnector.usbClients.get(params.id);
    if (!client) {
      if (!this.option.enableWebSocket) {
        defaultLogger.warn("enableWebSocket isn't opened!");
        return;
      }

      throw createControlError(
        "multiplexer-client-not-found",
        `Multiplexer target app client was not found: ${params.id}`,
      );
    }

    const data = parseJsonMessage(params.message);
    if (data?.data?.type === "UsbConnect" || data?.data?.type === "UsbConnectAck") {
      return;
    }
    if (data?.data?.data?.client_id) {
      data.data.data.client_id = -1;
    }
    client.sendMessage(data);
  }

  private async sendCustomizedMessage(
    params: ControlRpcParams["sendCustomizedMessage"],
  ): Promise<string> {
    const client = this.getUsbClient(params.clientId);
    return client.sendCustomizedMessage(
      params.method,
      normalizeCustomizedParams(params.params),
      params.sessionId ?? -1,
      params.type ?? "CDP",
    );
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

  private async ensureClientDiscoveryForCurrentDevices(): Promise<void> {
    const deviceIds = Array.from(this.physicalConnector.devices.keys());
    await Promise.all(
      deviceIds.map((deviceId) => this.ensureClientDiscovery(deviceId)),
    );
  }

  private clearClientDiscoveryForDevice(deviceId: string): void {
    this.clientDiscoveryStartedDeviceIds.delete(deviceId);
    this.clientDiscoveryStartingByDeviceId.delete(deviceId);
  }

  private resetDiscoveryState(): void {
    this.deviceDiscoveryStarted = false;
    this.deviceDiscoveryStarting = null;
    this.deviceDiscoveryAutoListensClients = false;
    this.clientDiscoveryStartedDeviceIds.clear();
    this.clientDiscoveryStartingByDeviceId.clear();
    this.allClientWatchersRequested = false;
    this.webSocketServerStarted = false;
    this.webSocketServerStarting = null;
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
