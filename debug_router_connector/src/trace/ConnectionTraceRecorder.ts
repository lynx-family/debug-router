// Copyright 2024 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

import { randomUUID } from "crypto";
import fs from "fs";
import { defaultLogger } from "../utils/logger";
import { EventEmitter, errorMonitor } from "events";
import type { ClientQuery, DeviceDescription } from "../utils/type";
import { UsbClient } from "../usb/Client";
import type { WebSocketClient } from "../websocket/WebSocketConnection";

type TraceReasons = {
  direct_discovery:
    | "disabled"
    | "started"
    | "snapshot"
    | "changed"
    | "failed"
    | "stopped";
  direct_device: "preparing" | "registered" | "unregistered" | "failed";
  direct_watch: "started" | "stopped" | "probe_failed";
  websocket_server: "disabled" | "starting" | "listening" | "failed" | "closed";
  connection: "connected" | "register_received" | "failed" | "closed";
  client: "connected" | "disconnected";
};

export type ConnectionTraceNode = {
  sequence: number;
  deviceId?: string;
  event: keyof TraceReasons;
  reason: TraceReasons[keyof TraceReasons];
  timestamp: string;
  traceSchemaVersion: string;
  connectionAttemptId?: string;
  metadata?: Record<string, any>;
};

export type ConnectionTraceOptions = {
  enabled?: boolean;
  output?: string;
};

const TRACE_SCHEMA_VERSION = "0.1";
type TraceContext = {
  deviceId?: string;
  connectionAttemptId?: string;
  metadata: Record<string, any>;
};

type Attempt = TraceContext & {
  connected: boolean;
  ended: boolean;
};

type Watch = { info: DeviceDescription; failures: Record<string, any>[] };

export class ConnectionTraceRecorder {
  private readonly stream: fs.WriteStream;
  private nextSequenceValue = 0;
  private attempts = new WeakMap<object, Attempt>();
  private registrations = new WeakMap<object, Attempt>();
  private clients = new Map<number, TraceContext>();
  private watches = new Map<object, Watch>();
  private cleanups = new Set<() => void>();
  private closed = false;
  private closePromise?: Promise<void>;

  constructor(path: string) {
    this.stream = fs.createWriteStream(path, { flags: "a" });
    this.stream.on("error", (error) => {
      defaultLogger.warn(`connection trace write error: ${error.message}`);
    });
  }

  close(): Promise<void> {
    if (this.closePromise) {
      return this.closePromise;
    }
    for (const owner of this.watches.keys()) this.stopWatch(owner);
    this.closed = true;
    for (const cleanup of this.cleanups) cleanup();
    this.cleanups.clear();
    this.clients.clear();
    this.attempts = new WeakMap();
    this.registrations = new WeakMap();
    this.closePromise = new Promise((resolve) => {
      if (this.stream.destroyed) {
        resolve();
        return;
      }
      // File streams close after flushing, or after an open/write error.
      this.stream.once("close", resolve);
      this.stream.end();
    });
    return this.closePromise;
  }

  record<E extends keyof TraceReasons>(
    event: E,
    reason: TraceReasons[E],
    { deviceId, connectionAttemptId, metadata }: Partial<TraceContext> = {},
    error?: any,
  ): void {
    if (this.closed) return;
    const node: ConnectionTraceNode = {
      sequence: ++this.nextSequenceValue,
      event,
      reason,
      deviceId,
      timestamp: new Date().toISOString(),
      traceSchemaVersion: TRACE_SCHEMA_VERSION,
      connectionAttemptId,
      metadata: {
        ...metadata,
        ...this.errorDetails(error),
      },
    };
    try {
      if (!this.stream.destroyed)
        this.stream.write(`${JSON.stringify(node)}\n`);
    } catch (err: any) {
      defaultLogger.warn(`connection trace write error: ${err?.message}`);
    }
  }

  device(reason: TraceReasons["direct_device"], info: DeviceDescription): void {
    this.record("direct_device", reason, {
      deviceId: info.serial,
      metadata: {
        os: info.os,
        title: info.title,
      },
    });
  }

  forwardResult(
    info: DeviceDescription,
    ports: number[],
    failures: { remotePort: number; error: unknown }[] = [],
  ): void {
    this.record("direct_device", failures.length ? "failed" : "preparing", {
      deviceId: info.serial,
      metadata: {
        os: info.os,
        step: "forward",
        ports: [...ports],
        failures: failures.map(({ remotePort, error }) => ({
          remotePort,
          ...this.errorDetails(error),
        })),
      },
    });
  }

  // Observe the existing discovery stream; never issue a second discovery request.
  discovery(tracker: EventEmitter, os: "Android" | "Harmony" | "iOS"): void {
    if (this.closed) return;
    let first = true;
    let previous = "";
    if (os !== "iOS")
      this.record("direct_discovery", "started", { metadata: { os } });
    const listeners: Record<string, (...args: any[]) => void> = {
      error: (error) =>
        this.record(
          "direct_discovery",
          "failed",
          { metadata: { os, step: "watch" } },
          error,
        ),
      end: () =>
        this.record("direct_discovery", "stopped", { metadata: { os } }),
    };
    if (os === "Android") {
      listeners.changeSet = ({ added, changed, removed }) => {
        const describe = (d: any) => ({ deviceId: d.id, status: d.type });
        if (first || added.length || changed.length || removed.length) {
          this.record("direct_discovery", first ? "snapshot" : "changed", {
            metadata: first
              ? { os, devices: added.map(describe) }
              : {
                  os,
                  added: added.map(describe),
                  changed: changed.map(describe),
                  removed: removed.map(describe),
                },
          });
        }
        first = false;
      };
    } else if (os === "Harmony") {
      listeners.queryError = (error) => {
        previous = ""; // Emit the next successful list even if its contents are unchanged.
        this.record(
          "direct_discovery",
          "failed",
          { metadata: { os, step: "list_targets" } },
          error,
        );
      };
      listeners.snapshot = (targets) => {
        const devices = targets.map((t: any) => ({
          deviceId: t.connectKey,
          status: t.connStatus,
        }));
        const current = JSON.stringify(devices);
        if (first || current !== previous)
          this.record("direct_discovery", first ? "snapshot" : "changed", {
            metadata: { os, devices },
          });
        first = false;
        previous = current;
      };
    } else {
      listeners.listening = () =>
        this.record("direct_discovery", "started", { metadata: { os } });
      listeners.attached = (deviceId) =>
        this.record("direct_discovery", "changed", {
          deviceId: deviceId,
          metadata: {
            os,
            status: "attached",
          },
        });
      listeners.detached = (deviceId) =>
        this.record("direct_discovery", "changed", {
          deviceId: deviceId,
          metadata: {
            os,
            status: "detached",
          },
        });
      listeners.usbmux_error = listeners.error;
      delete listeners.error; // usbmux translates native errors into usbmux_error.
      listeners.close = listeners.end;
      delete listeners.end;
    }
    this.observe(tracker, listeners);
  }

  startWatch(owner: object, info: DeviceDescription): void {
    if (this.closed || this.watches.has(owner)) return;
    this.watches.set(owner, { info, failures: [] });
    this.record("direct_watch", "started", {
      deviceId: info.serial,
      metadata: { os: info.os },
    });
  }

  flushProbes(owner: object): void {
    const watch = this.watches.get(owner);
    if (!watch?.failures.length) return;
    this.record("direct_watch", "probe_failed", {
      deviceId: watch.info.serial,
      metadata: {
        os: watch.info.os,
        failures: watch.failures,
      },
    });
    watch.failures = [];
  }

  stopWatch(owner: object): void {
    const watch = this.watches.get(owner);
    if (!watch) return;
    this.flushProbes(owner);
    this.record("direct_watch", "stopped", {
      deviceId: watch.info.serial,
      metadata: {
        os: watch.info.os,
      },
    });
    this.watches.delete(owner);
  }

  probeFailed(
    owner: object | null,
    deviceId: string,
    port: number,
    error: any,
    step = "connect",
  ): void {
    if (this.closed) return;
    const failure = { port, step, ...this.errorDetails(error) };
    const watch = owner && this.watches.get(owner);
    if (watch) watch.failures.push(failure);
    else
      this.record("direct_watch", "probe_failed", {
        deviceId: deviceId,
        metadata: {
          failures: [failure],
        },
      });
  }

  // Each socket owns its identity. Old closes can never remove a newer attempt.
  socket(
    socket: EventEmitter,
    metadata: Record<string, any>,
    deviceId?: string,
    owner: object | null = null,
    connected = false,
  ): void {
    if (this.closed || this.attempts.has(socket)) return;
    const attempt: Attempt = {
      deviceId,
      connectionAttemptId: randomUUID(),
      metadata,
      connected: false,
      ended: false,
    };
    this.attempts.set(socket, attempt);
    const onConnected = () => {
      if (attempt.connected || attempt.ended) return;
      attempt.connected = true;
      this.connection(socket, "connected");
    };
    const onError = (error: any) => {
      if (attempt.ended) return;
      if (attempt.connected) this.connection(socket, "failed", "socket", error);
      else this.probeFailed(owner, deviceId!, metadata.port, error);
      attempt.ended = true;
    };
    this.observe(socket, {
      connect: onConnected,
      [errorMonitor]: onError,
      usbmux_error: onError,
      close: (code, reason) => {
        if (!attempt.ended && attempt.connected)
          this.connection(
            socket,
            "closed",
            undefined,
            undefined,
            metadata.transport === "websocket"
              ? { code, closeReason: reason?.toString() }
              : undefined,
          );
        attempt.ended = true;
      },
    });
    if (connected) onConnected();
  }

  connection(
    socket: object,
    reason: TraceReasons["connection"],
    step?: string,
    error?: any,
    metadata?: Record<string, any>,
  ): void {
    const attempt = this.attempts.get(socket);
    if (!attempt || attempt.ended) return;
    this.record(
      "connection",
      reason,
      {
        deviceId: attempt.deviceId,
        connectionAttemptId: attempt.connectionAttemptId,
        metadata: { ...attempt.metadata, ...metadata, step },
      },
      error,
    );
  }

  register(socket: object, info: ClientQuery | WebSocketClient["info"]): void {
    const attempt = this.attempts.get(socket);
    if (!attempt || attempt.ended || this.closed) return;
    this.registrations.set(info, attempt);
    this.connection(
      socket,
      "register_received",
      undefined,
      undefined,
      this.clientMetadata(info),
    );
  }

  onEvent(event: string, payload: any): void {
    if (this.closed) return;
    let entry: TraceContext | undefined;
    let reason: TraceReasons["client"];
    if (
      event === "app-client-connected" ||
      event === "websocket-web-client-connected"
    ) {
      const client = payload as UsbClient | WebSocketClient;
      const direct = client instanceof UsbClient;
      const info = direct ? client.info.query : client.info;
      const attempt = this.registrations.get(info);
      entry = {
        deviceId: direct ? client.deviceId() : undefined,
        connectionAttemptId: attempt?.connectionAttemptId,
        metadata: {
          transport: direct ? "direct" : "websocket",
          role: event === "websocket-web-client-connected" ? "debugger" : "app",
          clientId: client.clientId(),
        },
      };
      this.clients.set(client.clientId(), entry);
      reason = "connected";
    } else if (
      event === "app-client-disconnected" ||
      event === "websocket-web-client-disconnected"
    ) {
      entry = this.clients.get(payload);
      if (!entry) return;
      this.clients.delete(payload);
      reason = "disconnected";
    } else return;
    this.record("client", reason, entry);
  }

  private clientMetadata(
    info: ClientQuery | WebSocketClient["info"],
  ): Record<string, any> {
    if ("device_id" in info)
      return {
        app: info.app,
        os: info.os,
        device: info.device,
        deviceModel: info.device_model,
        sdkVersion: info.sdk_version,
      };
    return {
      app: info.app,
      deviceModel: info.deviceModel,
      sdkVersion: info.sdkVersion,
      osVersion: info.osVersion,
      type: info.type,
    };
  }

  private errorDetails(error: any): Record<string, any> {
    return error === undefined
      ? {}
      : { error: String(error?.message ?? error), errorCode: error?.code };
  }

  private observe(
    emitter: EventEmitter,
    listeners: Record<PropertyKey, (...args: any[]) => void>,
  ): void {
    const cleanup = () => {
      for (const event of Reflect.ownKeys(listeners))
        emitter.off(event, listeners[event]);
      emitter.off("close", cleanup);
      emitter.off("end", cleanup);
      emitter.off("error", cleanup);
      this.cleanups.delete(cleanup);
    };
    for (const event of Reflect.ownKeys(listeners))
      emitter.prependListener(event, listeners[event]);
    emitter.once("close", cleanup);
    if (listeners.end) {
      emitter.once("end", cleanup);
      if (listeners.queryError) emitter.once("error", cleanup);
    }
    this.cleanups.add(cleanup);
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
    return new ConnectionTraceRecorder(output);
  } catch (err: any) {
    defaultLogger.warn(`connection trace init error: ${err?.message}`);
    return null;
  }
}
