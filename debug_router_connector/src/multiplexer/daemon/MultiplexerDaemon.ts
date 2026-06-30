// Copyright 2024 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

import {
  MULTIPLEXER_MIN_SUPPORTED_PROTOCOL_VERSION,
  MULTIPLEXER_PROTOCOL_VERSION,
  MultiplexerDiscoveryInfo,
} from "../protocol";
import { removeFileIfExists, writeJsonAtomic } from "../utils/atomic_file";
import { FileLock } from "../utils/FileLock";

export const DEFAULT_MULTIPLEXER_HEARTBEAT_INTERVAL = 1000;

export type MultiplexerDaemonHost = {
  start: (option?: unknown) => void | Promise<void>;
  stop: () => void | Promise<void>;
  getControlPort: () => number;
  setIdleTimeoutHandler?: (handler: () => void | Promise<void>) => void;
};

export type MultiplexerDaemonOption = {
  discoveryPath: string;
  daemonLockPath: string;
  protocolVersion?: number;
  minSupportedProtocolVersion?: number;
  daemonVersion?: string;
  capabilities?: string[];
  host: MultiplexerDaemonHost;
  hostOption?: unknown;

  // only used for testing
  heartbeatInterval?: number;
  now?: () => number;
  onIdleTimeout?: (stopError?: unknown) => void | Promise<void>;
};

export class MultiplexerDaemon {
  discoveryInfo: MultiplexerDiscoveryInfo | null = null;
  daemonLock: FileLock;
  host: MultiplexerDaemonHost;
  heartbeatTimer?: NodeJS.Timeout;

  private option: MultiplexerDaemonOption;
  private started = false;
  private hostStarted = false;
  private startedAt: number | null = null;
  private readonly defaultNow = Date.now;

  constructor(option: MultiplexerDaemonOption) {
    this.option = option;
    this.daemonLock = new FileLock(option.daemonLockPath);
    this.host = option.host;
  }

  async start(): Promise<void> {
    if (this.started) {
      return;
    }

    this.holdDaemonLock();

    try {
      await this.startHost();
      this.startedAt = this.now();
      this.discoveryInfo = this.createDiscoveryInfo();
      this.writeDiscovery();
      this.startHeartbeatTimer();
      this.started = true;
    } catch (error) {
      await this.stop();
      throw error;
    }
  }

  async stop(): Promise<void> {
    let hostStopError: unknown;

    this.stopHeartbeatTimer();

    try {
      await this.stopHost();
    } catch (error) {
      hostStopError = error;
    }

    this.removeDiscovery();
    this.releaseDaemonLock();
    this.discoveryInfo = null;
    this.startedAt = null;
    this.started = false;

    if (hostStopError) {
      throw hostStopError;
    }
  }

  writeDiscovery(): void {
    writeJsonAtomic(this.option.discoveryPath, this.discoveryInfo);
  }

  refreshHeartbeat(): void {
    this.discoveryInfo = {
      ...this.discoveryInfo!,
      heartbeat: this.now(),
    };
    this.writeDiscovery();
  }

  removeDiscovery(): void {
    removeFileIfExists(this.option.discoveryPath);
  }

  holdDaemonLock(): void {
    if (!this.daemonLock.acquire()) {
      throw new Error(
        `Failed to acquire multiplexer daemon lock: ${this.daemonLock.lockPath}`,
      );
    }
  }

  releaseDaemonLock(): void {
    this.daemonLock.release();
  }

  createDiscoveryInfo(): MultiplexerDiscoveryInfo {
    const controlPort = this.resolveControlPort();
    const startedAt = this.startedAt ?? this.now();

    return {
      pid: process.pid,
      protocolVersion:
        this.option.protocolVersion ?? MULTIPLEXER_PROTOCOL_VERSION,
      minSupportedProtocolVersion:
        this.option.minSupportedProtocolVersion ??
        MULTIPLEXER_MIN_SUPPORTED_PROTOCOL_VERSION,
      controlPort,
      heartbeat: this.now(),
      startedAt,
      daemonVersion: this.option.daemonVersion,
      capabilities: this.option.capabilities
        ? [...this.option.capabilities]
        : undefined,
    };
  }

  startHeartbeatTimer(): void {
    this.stopHeartbeatTimer();
    this.heartbeatTimer = setInterval(() => {
      this.refreshHeartbeat();
    }, this.option.heartbeatInterval ?? DEFAULT_MULTIPLEXER_HEARTBEAT_INTERVAL);
  }

  stopHeartbeatTimer(): void {
    if (!this.heartbeatTimer) {
      return;
    }

    clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = undefined;
  }

  private async startHost(): Promise<void> {
    if (this.hostStarted) {
      return;
    }

    this.host.setIdleTimeoutHandler?.(this.handleHostIdleTimeout);
    await this.host.start(this.option?.hostOption);
    this.hostStarted = true;
  }

  private async stopHost(): Promise<void> {
    if (!this.hostStarted) {
      return;
    }

    await this.host.stop();
    this.hostStarted = false;
  }

  private resolveControlPort(): number {
    const controlPort = this.host?.getControlPort?.() ?? 0;
    if (
      !Number.isInteger(controlPort) ||
      controlPort <= 0 ||
      controlPort > 65535
    ) {
      throw new Error(
        `Invalid multiplexer daemon control port: ${controlPort}`,
      );
    }

    return controlPort;
  }

  private now(): number {
    return this.option?.now?.() ?? this.defaultNow();
  }

  private readonly handleHostIdleTimeout = async (): Promise<void> => {
    let stopError: unknown;
    try {
      await this.stop();
    } catch (error) {
      stopError = error;
    }

    try {
      await this.option.onIdleTimeout?.(stopError);
    } catch (_error) {
      // Process-level cleanup handlers will retry stop on exit paths.
    }
  };
}
