// Copyright 2024 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

import { randomUUID } from "crypto";
import fs from "fs";
import { defaultLogger } from "../utils/logger";
import type { Client } from "../connector/Client";
import { UsbClient } from "../usb/Client";
import type { WebSocketClient } from "../websocket/WebSocketConnection";

export type ConnectionTraceNode = {
  sequence: number;
  deviceId?: string;
  event: string;
  timestamp: string;
  traceSchemaVersion: string;
  connectionAttemptId?: string;
  metadata?: Record<string, any>;
};

export type ConnectionTraceOptions = {
  enabled?: boolean;
  output?: string | NodeJS.WritableStream;
  bufferSize?: number;
};

const TRACE_SCHEMA_VERSION = "0.1";
const DEFAULT_TRACE_BUFFER_SIZE = 2000;

type TraceListener = (node: ConnectionTraceNode) => void;

interface ConnectionTraceSink {
  write(node: ConnectionTraceNode): void;
  close(): Promise<void>;
}

class StreamTraceSink implements ConnectionTraceSink {
  constructor(private readonly stream: NodeJS.WritableStream) {}

  write(node: ConnectionTraceNode): void {
    this.stream.write(`${JSON.stringify(node)}\n`);
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}

class FileTraceSink implements ConnectionTraceSink {
  private readonly stream: fs.WriteStream;
  private closed = false;
  private closePromise?: Promise<void>;

  constructor(path: string) {
    this.stream = fs.createWriteStream(path, { flags: "a" });
    this.stream.on("error", (err) => {
      defaultLogger.warn(`connection trace write error: ${err?.message}`);
    });
  }

  write(node: ConnectionTraceNode): void {
    if (this.closed) {
      return;
    }
    this.stream.write(`${JSON.stringify(node)}\n`);
  }

  close(): Promise<void> {
    if (this.closePromise) {
      return this.closePromise;
    }
    this.closed = true;
    this.closePromise = new Promise((resolve) => {
      if (this.stream.destroyed) {
        resolve();
        return;
      }
      this.stream.end(resolve);
    });
    return this.closePromise;
  }
}

type ClientTraceInfo = {
  deviceId?: string;
  port?: number;
  connectionAttemptId?: string;
};

type UsbConnectionContext = {
  deviceId?: string;
  port?: number;
  clientId?: number;
  connectionAttemptId?: string;
};

export class ConnectionTraceRecorder {
  private readonly sink: ConnectionTraceSink;
  private readonly maxBufferedNodes: number;
  private nextSequenceValue = 0;
  private connectionAttemptByPort = new Map<string, string>();
  private usbClientConnections = new Map<number, ClientTraceInfo>();
  private appClientConnections = new Map<number, ClientTraceInfo>();
  private listeners = new Set<TraceListener>();
  private recentNodes: ConnectionTraceNode[] = [];
  private closed = false;
  private closePromise?: Promise<void>;

  constructor(
    sink: ConnectionTraceSink,
    maxBufferedNodes = DEFAULT_TRACE_BUFFER_SIZE,
  ) {
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

  close(): Promise<void> {
    if (this.closePromise) {
      return this.closePromise;
    }
    this.closed = true;
    this.listeners.clear();
    this.connectionAttemptByPort.clear();
    this.usbClientConnections.clear();
    this.appClientConnections.clear();
    this.recentNodes = [];
    this.closePromise = this.sink.close().catch((err: any) => {
      defaultLogger.warn(`connection trace close error: ${err?.message}`);
    });
    return this.closePromise;
  }

  recordDevicePlug(deviceId: string, metadata?: Record<string, any>): void {
    this.clearStaleDeviceTraceState(deviceId);
    this.recordNode("device_plugged", deviceId, metadata);
  }

  recordDeviceUnplug(deviceId: string, metadata?: Record<string, any>): void {
    this.recordNode("device_unplugged", deviceId, metadata);
  }

  recordDeviceRegistered(
    deviceId: string,
    metadata?: Record<string, any>,
  ): void {
    this.recordNode("device_registered", deviceId, metadata);
  }

  recordDeviceUnregistered(
    deviceId: string,
    metadata?: Record<string, any>,
  ): void {
    this.recordNode("device_unregistered", deviceId, metadata);
  }

  recordWatchClientStart(
    deviceId: string,
    metadata?: Record<string, any>,
  ): void {
    this.recordNode("client_watch_started", deviceId, metadata);
  }

  recordWatchClientStop(
    deviceId: string,
    metadata?: Record<string, any>,
  ): void {
    this.recordNode("client_watch_stopped", deviceId, metadata);
  }

  recordSocketConnected(
    deviceId: string,
    port: number,
    metadata?: Record<string, any>,
  ): string {
    const connectionAttemptId = this.startConnectionAttempt(deviceId, port);
    this.recordNode(
      "socket_connected",
      deviceId,
      {
        port,
        ...metadata,
      },
      connectionAttemptId,
    );
    return connectionAttemptId;
  }

  recordSocketDisconnected(
    deviceId: string,
    port: number,
    metadata?: Record<string, any>,
    connectionAttemptId?: string,
  ): void {
    const resolvedConnectionAttemptId =
      connectionAttemptId ?? this.findConnectionAttempt(deviceId, port);
    this.recordNode(
      "socket_disconnected",
      deviceId,
      {
        port,
        ...metadata,
      },
      resolvedConnectionAttemptId,
    );
    this.connectionAttemptByPort.delete(this.portKey(deviceId, port));
  }

  recordSdkRegister(
    deviceId: string,
    port: number,
    metadata?: Record<string, any>,
    connectionAttemptId?: string,
  ): void {
    const resolvedConnectionAttemptId =
      connectionAttemptId ?? this.resolveConnectionAttempt(deviceId, port);
    this.recordNode(
      "sdk_register_received",
      deviceId,
      {
        port,
        ...metadata,
      },
      resolvedConnectionAttemptId,
    );
  }

  recordUsbClientConnected(client: UsbClient): void {
    const deviceId = client.deviceId();
    const port = client.info.port;
    const connectionAttemptId = this.resolveConnectionAttempt(deviceId, port);
    this.recordNode(
      "usb_client_connected",
      deviceId,
      {
        clientId: client.clientId(),
        port,
        app: client.info.query.app,
        os: client.info.query.os,
        device: client.info.query.device,
        deviceModel: client.info.query.device_model,
        sdkVersion: client.info.query.sdk_version,
      },
      connectionAttemptId,
    );
    this.usbClientConnections.set(client.clientId(), {
      deviceId,
      port,
      connectionAttemptId,
    });
  }

  recordUsbClientDisconnected(client: UsbClient): void {
    const deviceId = client.deviceId();
    const port = client.info.port;
    const entry = this.usbClientConnections.get(client.clientId());
    const connectionAttemptId =
      entry?.connectionAttemptId ?? this.findConnectionAttempt(deviceId, port);
    this.recordNode(
      "usb_client_disconnected",
      deviceId,
      {
        clientId: client.clientId(),
        port,
        app: client.info.query.app,
        os: client.info.query.os,
        device: client.info.query.device,
        deviceModel: client.info.query.device_model,
        sdkVersion: client.info.query.sdk_version,
      },
      connectionAttemptId,
    );
    this.usbClientConnections.delete(client.clientId());
  }

  recordUsbConnectionClosed(context: UsbConnectionContext): void {
    const clientId = context.clientId;
    const entry = clientId
      ? this.usbClientConnections.get(clientId)
      : undefined;
    const deviceId = entry?.deviceId ?? context.deviceId;
    const port = entry?.port ?? context.port;
    const connectionAttemptId =
      context.connectionAttemptId ??
      entry?.connectionAttemptId ??
      (deviceId && port
        ? this.findConnectionAttempt(deviceId, port)
        : undefined);

    this.recordNode(
      "usb_connection_closed",
      deviceId,
      {
        clientId,
        port,
      },
      connectionAttemptId,
    );
  }

  recordAppClientConnected(client: Client): void {
    if (!(client instanceof UsbClient)) {
      return;
    }
    const deviceId = client.deviceId();
    const port = client.info.port;
    const usbEntry = this.usbClientConnections.get(client.clientId());
    const connectionAttemptId =
      usbEntry?.connectionAttemptId ??
      this.resolveConnectionAttempt(deviceId, port);

    this.recordNode(
      "app_client_connected",
      deviceId,
      {
        clientId: client.clientId(),
        port,
        app: client.info.query.app,
        os: client.info.query.os,
        device: client.info.query.device,
        deviceModel: client.info.query.device_model,
        sdkVersion: client.info.query.sdk_version,
      },
      connectionAttemptId,
    );
    this.appClientConnections.set(client.clientId(), {
      deviceId,
      port,
      connectionAttemptId,
    });
  }

  recordAppClientDisconnected(clientId: number): void {
    const entry = this.appClientConnections.get(clientId);
    this.recordNode(
      "app_client_disconnected",
      entry?.deviceId,
      {
        clientId,
        port: entry?.port,
      },
      entry?.connectionAttemptId,
    );
    this.appClientConnections.delete(clientId);
  }

  recordWebsocketAppClientConnected(client: WebSocketClient): void {
    this.recordNode("websocket_app_client_connected", undefined, {
      clientId: client.clientId(),
      app: client.info.app,
      deviceModel: client.info.deviceModel,
      sdkVersion: client.info.sdkVersion,
      osVersion: client.info.osVersion,
      type: client.info.type,
    });
  }

  recordWebsocketAppClientDisconnected(clientId: number): void {
    this.recordNode("websocket_app_client_disconnected", undefined, {
      clientId,
    });
  }

  recordWebsocketWebClientConnected(client: WebSocketClient): void {
    this.recordNode("websocket_web_client_connected", undefined, {
      clientId: client.clientId(),
      type: client.info.type,
    });
  }

  recordWebsocketWebClientDisconnected(clientId: number): void {
    this.recordNode("websocket_web_client_disconnected", undefined, {
      clientId,
    });
  }

  private recordNode(
    event: string,
    deviceId?: string,
    metadata?: Record<string, any>,
    connectionAttemptId?: string,
  ): ConnectionTraceNode {
    const node: ConnectionTraceNode = {
      sequence: this.nextSequence(),
      deviceId,
      event,
      timestamp: new Date().toISOString(),
      traceSchemaVersion: TRACE_SCHEMA_VERSION,
      connectionAttemptId,
      metadata: this.compactMetadata(metadata),
    };
    if (!this.closed) {
      try {
        this.sink.write(node);
      } catch (err: any) {
        defaultLogger.warn(`connection trace write error: ${err?.message}`);
      }
      this.pushRecentNode(node);
      this.emitNode(node);
    }
    return node;
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

  private startConnectionAttempt(deviceId: string, port: number): string {
    const connectionAttemptId = randomUUID();
    this.connectionAttemptByPort.set(
      this.portKey(deviceId, port),
      connectionAttemptId,
    );
    return connectionAttemptId;
  }

  private resolveConnectionAttempt(deviceId: string, port: number): string {
    return (
      this.findConnectionAttempt(deviceId, port) ??
      this.startConnectionAttempt(deviceId, port)
    );
  }

  private findConnectionAttempt(
    deviceId: string,
    port: number,
  ): string | undefined {
    return this.connectionAttemptByPort.get(this.portKey(deviceId, port));
  }

  private nextSequence(): number {
    this.nextSequenceValue += 1;
    return this.nextSequenceValue;
  }

  private portKey(deviceId: string, port: number): string {
    return `${deviceId}:${port}`;
  }

  private compactMetadata(
    metadata?: Record<string, any>,
  ): Record<string, any> | undefined {
    if (!metadata) {
      return undefined;
    }
    const compacted: Record<string, any> = {};
    for (const [key, value] of Object.entries(metadata)) {
      if (value !== undefined) {
        compacted[key] = value;
      }
    }
    return Object.keys(compacted).length > 0 ? compacted : undefined;
  }

  private clearStaleDeviceTraceState(deviceId: string): void {
    for (const key of this.connectionAttemptByPort.keys()) {
      if (key.startsWith(`${deviceId}:`)) {
        this.connectionAttemptByPort.delete(key);
      }
    }
    for (const [clientId, entry] of this.usbClientConnections.entries()) {
      if (entry.deviceId === deviceId) {
        this.usbClientConnections.delete(clientId);
      }
    }
    for (const [clientId, entry] of this.appClientConnections.entries()) {
      if (entry.deviceId === deviceId) {
        this.appClientConnections.delete(clientId);
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
  try {
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
  } catch (err: any) {
    defaultLogger.warn(`connection trace init error: ${err?.message}`);
    return null;
  }
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
