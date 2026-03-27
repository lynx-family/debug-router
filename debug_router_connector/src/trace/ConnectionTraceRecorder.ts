// Copyright 2024 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

import fs from "fs";
import { defaultLogger } from "../utils/logger";
import type { Client } from "../connector/Client";
import { UsbClient } from "../usb/Client";
import type { WebSocketClient } from "../websocket/WebSocketConnection";

export type ConnectionTraceNode = {
  id: string;
  parentId?: string;
  deviceId?: string;
  event: string;
  timestamp: string;
  traceSchemaVersion: number;
  metadata?: Record<string, any>;
};

export type ConnectionTraceOptions = {
  enabled?: boolean;
  output?: string | NodeJS.WritableStream;
  bufferSize?: number;
};

const TRACE_SCHEMA_VERSION = 1;
const DEFAULT_TRACE_BUFFER_SIZE = 2000;

type TraceListener = (node: ConnectionTraceNode) => void;

interface ConnectionTraceSink {
  write(node: ConnectionTraceNode): void;
}

class StreamTraceSink implements ConnectionTraceSink {
  constructor(private readonly stream: NodeJS.WritableStream) {}

  write(node: ConnectionTraceNode): void {
    this.stream.write(`${JSON.stringify(node)}\n`);
  }
}

class FileTraceSink implements ConnectionTraceSink {
  private readonly stream: fs.WriteStream;

  constructor(path: string) {
    this.stream = fs.createWriteStream(path, { flags: "a" });
    this.stream.on("error", (err) => {
      defaultLogger.warn(`connection trace write error: ${err?.message}`);
    });
  }

  write(node: ConnectionTraceNode): void {
    this.stream.write(`${JSON.stringify(node)}\n`);
  }
}

type ClientNodeInfo = {
  nodeId: string;
  deviceId?: string;
  port?: number;
  logicalSessionKey?: string;
};

type UsbConnectionContext = {
  deviceId?: string;
  port?: number;
  clientId?: number;
};

export class ConnectionTraceRecorder {
  private readonly sink: ConnectionTraceSink;
  private readonly maxBufferedNodes: number;
  private nextId = 0;
  private deviceRoots = new Map<string, string>();
  private socketNodes = new Map<string, string>();
  private registerNodes = new Map<string, string>();
  private logicalSessionByPort = new Map<string, string>();
  private usbClientNodes = new Map<number, ClientNodeInfo>();
  private appClientNodes = new Map<number, ClientNodeInfo>();
  private websocketAppNodes = new Map<number, ClientNodeInfo>();
  private websocketWebNodes = new Map<number, ClientNodeInfo>();
  private listeners = new Set<TraceListener>();
  private recentNodes: ConnectionTraceNode[] = [];

  constructor(sink: ConnectionTraceSink, maxBufferedNodes = DEFAULT_TRACE_BUFFER_SIZE) {
    this.sink = sink;
    this.maxBufferedNodes = Math.max(0, maxBufferedNodes);
  }

  addListener(listener: TraceListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  getRecentNodes(limit?: number): ConnectionTraceNode[] {
    const target =
      limit && limit > 0 ? this.recentNodes.slice(-limit) : this.recentNodes;
    return target.map((node) => this.cloneNode(node));
  }

  recordDevicePlug(deviceId: string, metadata?: Record<string, any>): string {
    this.clearDevice(deviceId);
    const nodeId = this.recordNode("device_plugged", deviceId, undefined, {
      deviceId,
      ...metadata,
    });
    this.deviceRoots.set(deviceId, nodeId);
    return nodeId;
  }

  recordDeviceUnplug(deviceId: string, metadata?: Record<string, any>): void {
    const parentId = this.ensureDeviceRoot(deviceId);
    this.recordNode("device_unplugged", deviceId, parentId, {
      deviceId,
      ...metadata,
    });
  }

  recordDeviceRegistered(deviceId: string, metadata?: Record<string, any>): void {
    const parentId = this.ensureDeviceRoot(deviceId);
    this.recordNode("device_registered", deviceId, parentId, metadata);
  }

  recordDeviceUnregistered(deviceId: string, metadata?: Record<string, any>): void {
    const parentId = this.ensureDeviceRoot(deviceId);
    this.recordNode("device_unregistered", deviceId, parentId, metadata);
  }

  recordWatchClientStart(deviceId: string, metadata?: Record<string, any>): void {
    const parentId = this.ensureDeviceRoot(deviceId);
    this.recordNode("client_watch_started", deviceId, parentId, metadata);
  }

  recordWatchClientStop(deviceId: string, metadata?: Record<string, any>): void {
    const parentId = this.ensureDeviceRoot(deviceId);
    this.recordNode("client_watch_stopped", deviceId, parentId, metadata);
  }

  recordSocketConnected(
    deviceId: string,
    port: number,
    metadata?: Record<string, any>,
  ): void {
    const logicalSessionKey = this.findLogicalSessionKey(deviceId, port);
    const parentId = this.ensureDeviceRoot(deviceId);
    const nodeId = this.recordNode("socket_connected", deviceId, parentId, {
      port,
      logicalSessionKey,
      ...metadata,
    });
    this.socketNodes.set(this.portKey(deviceId, port), nodeId);
  }

  recordSocketDisconnected(
    deviceId: string,
    port: number,
    metadata?: Record<string, any>,
  ): void {
    const logicalSessionKey = this.findLogicalSessionKey(deviceId, port);
    const parentId =
      this.socketNodes.get(this.portKey(deviceId, port)) ??
      this.ensureDeviceRoot(deviceId);
    this.recordNode("socket_disconnected", deviceId, parentId, {
      port,
      logicalSessionKey,
      ...metadata,
    });
    this.socketNodes.delete(this.portKey(deviceId, port));
    this.registerNodes.delete(this.portKey(deviceId, port));
  }

  recordRegister(
    deviceId: string,
    port: number,
    metadata?: Record<string, any>,
  ): void {
    const appSignature = this.buildAppSignature(metadata);
    const logicalSessionKey = this.resolveLogicalSessionKey(
      deviceId,
      port,
      appSignature,
    );
    const parentId =
      this.socketNodes.get(this.portKey(deviceId, port)) ??
      this.ensureDeviceRoot(deviceId);
    const nodeId = this.recordNode("register_received", deviceId, parentId, {
      port,
      appSignature,
      logicalSessionKey,
      ...metadata,
    });
    this.registerNodes.set(this.portKey(deviceId, port), nodeId);
  }

  recordUsbClientConnected(client: UsbClient): void {
    const deviceId = client.deviceId();
    const port = client.info.port;
    const appSignature = this.buildAppSignature({
      app: client.info.query.app,
      os: client.info.query.os,
      deviceModel: client.info.query.device_model,
      sdkVersion: client.info.query.sdk_version,
    });
    const logicalSessionKey = this.resolveLogicalSessionKey(
      deviceId,
      port,
      appSignature,
    );
    const parentId =
      this.registerNodes.get(this.portKey(deviceId, port)) ??
      this.socketNodes.get(this.portKey(deviceId, port)) ??
      this.ensureDeviceRoot(deviceId);
    const nodeId = this.recordNode("usb_client_connected", deviceId, parentId, {
      clientId: client.clientId(),
      port,
      app: client.info.query.app,
      os: client.info.query.os,
      device: client.info.query.device,
      deviceModel: client.info.query.device_model,
      sdkVersion: client.info.query.sdk_version,
      appSignature,
      logicalSessionKey,
    });
    this.usbClientNodes.set(client.clientId(), {
      nodeId,
      deviceId,
      port,
      logicalSessionKey,
    });
  }

  recordUsbClientDisconnected(client: UsbClient): void {
    const deviceId = client.deviceId();
    const port = client.info.port;
    const entry = this.usbClientNodes.get(client.clientId());
    const appSignature = this.buildAppSignature({
      app: client.info.query.app,
      os: client.info.query.os,
      deviceModel: client.info.query.device_model,
      sdkVersion: client.info.query.sdk_version,
    });
    const logicalSessionKey =
      entry?.logicalSessionKey ??
      this.resolveLogicalSessionKey(deviceId, port, appSignature);
    const parentId =
      entry?.nodeId ??
      this.registerNodes.get(this.portKey(deviceId, port)) ??
      this.socketNodes.get(this.portKey(deviceId, port)) ??
      this.ensureDeviceRoot(deviceId);
    this.recordNode("usb_client_disconnected", deviceId, parentId, {
      clientId: client.clientId(),
      port,
      app: client.info.query.app,
      os: client.info.query.os,
      device: client.info.query.device,
      deviceModel: client.info.query.device_model,
      sdkVersion: client.info.query.sdk_version,
      appSignature,
      logicalSessionKey,
    });
    this.usbClientNodes.delete(client.clientId());
  }

  recordUsbConnectionClosed(context: UsbConnectionContext): void {
    const deviceId = context.deviceId;
    const port = context.port;
    const clientId = context.clientId;
    const entry = clientId ? this.usbClientNodes.get(clientId) : undefined;
    const logicalSessionKey =
      entry?.logicalSessionKey ??
      (deviceId && port
        ? this.findLogicalSessionKey(deviceId, port)
        : undefined);
    const parentId =
      entry?.nodeId ??
      (deviceId && port
        ? this.registerNodes.get(this.portKey(deviceId, port)) ??
          this.socketNodes.get(this.portKey(deviceId, port))
        : undefined) ??
      (deviceId ? this.ensureDeviceRoot(deviceId) : undefined);
    this.recordNode("usb_connection_closed", deviceId, parentId, {
      clientId,
      port,
      logicalSessionKey,
    });
  }

  recordAppClientConnected(client: Client): void {
    if (!(client instanceof UsbClient)) {
      return;
    }
    const deviceId = client.deviceId();
    const port = client.info.port;
    const appSignature = this.buildAppSignature({
      app: client.info.query.app,
      os: client.info.query.os,
      deviceModel: client.info.query.device_model,
      sdkVersion: client.info.query.sdk_version,
    });
    const logicalSessionKey =
      this.usbClientNodes.get(client.clientId())?.logicalSessionKey ??
      this.resolveLogicalSessionKey(deviceId, port, appSignature);
    const parentId =
      this.usbClientNodes.get(client.clientId())?.nodeId ??
      this.ensureDeviceRoot(deviceId);
    const nodeId = this.recordNode("app_client_connected", deviceId, parentId, {
      clientId: client.clientId(),
      port,
      app: client.info.query.app,
      os: client.info.query.os,
      device: client.info.query.device,
      deviceModel: client.info.query.device_model,
      sdkVersion: client.info.query.sdk_version,
      appSignature,
      logicalSessionKey,
    });
    this.appClientNodes.set(client.clientId(), {
      nodeId,
      deviceId,
      port,
      logicalSessionKey,
    });
  }

  recordAppClientDisconnected(clientId: number): void {
    const entry = this.appClientNodes.get(clientId);
    if (!entry) {
      return;
    }
    this.recordNode("app_client_disconnected", entry.deviceId, entry.nodeId, {
      clientId,
      port: entry.port,
      logicalSessionKey: entry.logicalSessionKey,
    });
    this.appClientNodes.delete(clientId);
  }

  recordWebsocketAppClientConnected(client: WebSocketClient): void {
    const nodeId = this.recordNode(
      "websocket_app_client_connected",
      undefined,
      undefined,
      {
        clientId: client.clientId(),
        app: client.info.app,
        deviceModel: client.info.deviceModel,
        sdkVersion: client.info.sdkVersion,
        osVersion: client.info.osVersion,
        type: client.info.type,
      },
    );
    this.websocketAppNodes.set(client.clientId(), { nodeId });
  }

  recordWebsocketAppClientDisconnected(clientId: number): void {
    const entry = this.websocketAppNodes.get(clientId);
    if (!entry) {
      return;
    }
    this.recordNode(
      "websocket_app_client_disconnected",
      undefined,
      entry.nodeId,
      {
        clientId,
      },
    );
    this.websocketAppNodes.delete(clientId);
  }

  recordWebsocketWebClientConnected(client: WebSocketClient): void {
    const nodeId = this.recordNode(
      "websocket_web_client_connected",
      undefined,
      undefined,
      {
        clientId: client.clientId(),
        type: client.info.type,
      },
    );
    this.websocketWebNodes.set(client.clientId(), { nodeId });
  }

  recordWebsocketWebClientDisconnected(clientId: number): void {
    const entry = this.websocketWebNodes.get(clientId);
    if (!entry) {
      return;
    }
    this.recordNode(
      "websocket_web_client_disconnected",
      undefined,
      entry.nodeId,
      {
        clientId,
      },
    );
    this.websocketWebNodes.delete(clientId);
  }

  private recordNode(
    event: string,
    deviceId?: string,
    parentId?: string,
    metadata?: Record<string, any>,
  ): string {
    const node: ConnectionTraceNode = {
      id: this.nextNodeId(),
      parentId,
      deviceId,
      event,
      timestamp: new Date().toISOString(),
      traceSchemaVersion: TRACE_SCHEMA_VERSION,
      metadata,
    };
    this.sink.write(node);
    this.pushRecentNode(node);
    this.emitNode(node);
    return node.id;
  }

  private pushRecentNode(node: ConnectionTraceNode): void {
    if (this.maxBufferedNodes <= 0) {
      return;
    }
    this.recentNodes.push(this.cloneNode(node));
    if (this.recentNodes.length > this.maxBufferedNodes) {
      this.recentNodes.shift();
    }
  }

  private emitNode(node: ConnectionTraceNode): void {
    if (this.listeners.size === 0) {
      return;
    }
    for (const listener of this.listeners) {
      try {
        listener(this.cloneNode(node));
      } catch (err: any) {
        defaultLogger.warn(`connection trace listener error: ${err?.message}`);
      }
    }
  }

  private cloneNode(node: ConnectionTraceNode): ConnectionTraceNode {
    return {
      ...node,
      metadata: node.metadata ? { ...node.metadata } : undefined,
    };
  }

  private findLogicalSessionKey(
    deviceId: string,
    port: number,
  ): string | undefined {
    return this.logicalSessionByPort.get(this.portKey(deviceId, port));
  }

  private resolveLogicalSessionKey(
    deviceId: string,
    port: number,
    appSignature?: string,
  ): string | undefined {
    const key = this.portKey(deviceId, port);
    if (appSignature) {
      const logicalSessionKey = `${deviceId}:${port}:${appSignature}`;
      this.logicalSessionByPort.set(key, logicalSessionKey);
      return logicalSessionKey;
    }
    return this.logicalSessionByPort.get(key);
  }

  private buildAppSignature(metadata?: Record<string, any>): string | undefined {
    if (!metadata) {
      return undefined;
    }
    const app = this.normalizeSignaturePart(metadata.app);
    const os = this.normalizeSignaturePart(metadata.os);
    const deviceModel = this.normalizeSignaturePart(metadata.deviceModel);
    const sdkVersion = this.normalizeSignaturePart(metadata.sdkVersion);
    if (!app || !os || !deviceModel || !sdkVersion) {
      return undefined;
    }
    return [app, os, deviceModel, sdkVersion].join("|");
  }

  private normalizeSignaturePart(value: any): string {
    if (typeof value !== "string") {
      return "";
    }
    return value.trim().replace(/\|/g, "_");
  }

  private ensureDeviceRoot(deviceId: string): string {
    const root = this.deviceRoots.get(deviceId);
    if (root) {
      return root;
    }
    return this.recordDevicePlug(deviceId, { implicit: true });
  }

  private nextNodeId(): string {
    this.nextId += 1;
    return `${this.nextId}`;
  }

  private portKey(deviceId: string, port: number): string {
    return `${deviceId}:${port}`;
  }

  private clearDevice(deviceId: string, clearClients: boolean = true): void {
    this.deviceRoots.delete(deviceId);
    for (const key of this.socketNodes.keys()) {
      if (key.startsWith(`${deviceId}:`)) {
        this.socketNodes.delete(key);
      }
    }
    for (const key of this.registerNodes.keys()) {
      if (key.startsWith(`${deviceId}:`)) {
        this.registerNodes.delete(key);
      }
    }
    for (const key of this.logicalSessionByPort.keys()) {
      if (key.startsWith(`${deviceId}:`)) {
        this.logicalSessionByPort.delete(key);
      }
    }
    if (clearClients) {
      for (const [id, entry] of this.usbClientNodes.entries()) {
        if (entry.deviceId === deviceId) {
          this.usbClientNodes.delete(id);
        }
      }
      for (const [id, entry] of this.appClientNodes.entries()) {
        if (entry.deviceId === deviceId) {
          this.appClientNodes.delete(id);
        }
      }
    }
  }
}

export function createConnectionTraceRecorder(
  options?: ConnectionTraceOptions,
  envPath?: string,
): ConnectionTraceRecorder | null {
  if (options?.enabled === false) {
    return null;
  }
  const output = options?.output ?? envPath;
  if (!output) {
    if (options?.enabled) {
      defaultLogger.warn("connection trace enabled without output");
    }
    return null;
  }
  if (typeof output === "string") {
    return new ConnectionTraceRecorder(
      new FileTraceSink(output),
      parseTraceBufferSize(options?.bufferSize),
    );
  }
  return new ConnectionTraceRecorder(
    new StreamTraceSink(output),
    parseTraceBufferSize(options?.bufferSize),
  );
}

function parseTraceBufferSize(optionBufferSize?: number): number {
  if (
    typeof optionBufferSize === "number" &&
    Number.isFinite(optionBufferSize) &&
    optionBufferSize >= 0
  ) {
    return Math.floor(optionBufferSize);
  }
  const envValue = process.env.DriverConnectionTraceBufferSize;
  if (!envValue) {
    return DEFAULT_TRACE_BUFFER_SIZE;
  }
  const parsed = Number(envValue);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return DEFAULT_TRACE_BUFFER_SIZE;
  }
  return Math.floor(parsed);
}
