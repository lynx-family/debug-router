// Copyright 2024 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

import fs from "fs";
import path from "path";
import { spawn as spawnChildProcess, SpawnOptions } from "child_process";
import {
  MULTIPLEXER_DAEMON_LOCK_NAME,
} from "../utils/paths";
import { FileLock } from "../utils/FileLock";
import { removeFileIfExists } from "../utils/atomic_file";
import {
  MULTIPLEXER_PROTOCOL_VERSION,
  MultiplexerDiscoveryInfo,
} from "../protocol/discovery";
import {
  MultiplexerDiscovery,
  MultiplexerDiscoveryValidation,
} from "./MultiplexerDiscovery";

export const DEFAULT_MULTIPLEXER_STARTUP_TIMEOUT = 5000;
export const DEFAULT_MULTIPLEXER_READY_POLL_INTERVAL = 100;
export const DEFAULT_MULTIPLEXER_REPLACEMENT_TIMEOUT = 1000;

export type MultiplexerDaemonReplaceReason =
  | "daemon-protocol-older-than-connector"
  | "stale-daemon"
  | "invalid-discovery";

export type SpawnedDaemonProcess = {
  pid?: number;
  unref(): void;
};

export type MultiplexerDaemonSpawn = (
  command: string,
  args: string[],
  options: SpawnOptions,
) => SpawnedDaemonProcess;

export type MultiplexerDaemonManagerOption = {
  discovery: MultiplexerDiscovery;
  spawnLockPath: string;
  daemonEntry: string;
  startupTimeout?: number;
  staleTimeout?: number;
  localProtocolVersion?: number;
  daemonLockPath?: string;
  controlPort?: number;
  heartbeatInterval?: number;
  daemonVersion?: string;
  capabilities?: string[];
  readyPollInterval?: number;
  replacementTimeout?: number;

  // only used for testing
  spawn?: MultiplexerDaemonSpawn;
  kill?: (pid: number, signal: NodeJS.Signals) => void;
  sleep?: (duration: number) => Promise<void>;
  now?: () => number;
};

export class MultiplexerDaemonManager {
  readonly discovery: MultiplexerDiscovery;
  readonly spawnLock: FileLock;
  readonly daemonLock: FileLock;
  readonly daemonEntry: string;
  readonly startupTimeout: number;
  readonly staleTimeout: number;
  readonly localProtocolVersion: number;
  readonly controlPort: number;
  readonly heartbeatInterval?: number;
  readonly daemonVersion?: string;
  readonly capabilities?: string[];
  private readonly readyPollInterval: number;
  private readonly replacementTimeout: number;
  private readonly spawnProcess: MultiplexerDaemonSpawn;
  private readonly killProcess: (pid: number, signal: NodeJS.Signals) => void;
  private readonly sleepFor: (duration: number) => Promise<void>;
  private readonly now: () => number;

  constructor(option: MultiplexerDaemonManagerOption) {
    this.discovery = option.discovery;
    this.spawnLock = new FileLock(option.spawnLockPath);
    this.daemonLock = new FileLock(
      option.daemonLockPath ?? getDaemonLockPathFromSpawnLock(option.spawnLockPath),
    );
    this.daemonEntry = option.daemonEntry;
    this.startupTimeout =
      option.startupTimeout ?? DEFAULT_MULTIPLEXER_STARTUP_TIMEOUT;
    this.staleTimeout = option.staleTimeout ?? this.discovery.staleTimeout;
    this.localProtocolVersion =
      option.localProtocolVersion ?? MULTIPLEXER_PROTOCOL_VERSION;
    this.controlPort = option.controlPort ?? 0;
    this.heartbeatInterval = option.heartbeatInterval;
    this.daemonVersion = option.daemonVersion;
    this.capabilities = option.capabilities;
    this.readyPollInterval =
      option.readyPollInterval ?? DEFAULT_MULTIPLEXER_READY_POLL_INTERVAL;
    this.replacementTimeout =
      option.replacementTimeout ?? DEFAULT_MULTIPLEXER_REPLACEMENT_TIMEOUT;
    this.spawnProcess = option.spawn ?? spawnChildProcess;
    this.killProcess = option.kill ?? process.kill;
    this.sleepFor = option.sleep ?? defaultSleep;
    this.now = option.now ?? Date.now;
  }

  async ensureDaemon(): Promise<MultiplexerDiscoveryInfo> {
    return this.handleDiscoveryValidation(this.discovery.validateDiscovery());
  }

  async handleDiscoveryValidation(
    validation: MultiplexerDiscoveryValidation,
  ): Promise<MultiplexerDiscoveryInfo> {
    if (validation.status === "usable") {
      return validation.info;
    }

    if (validation.status === "replace-required") {
      return this.ensureDaemonWithSpawnLock(async () => {
        await this.replaceOutdatedDaemon(
          validation.info,
          "daemon-protocol-older-than-connector",
        );
      });
    }

    return this.ensureDaemonWithSpawnLock(async () => {
      this.cleanupStaleDaemon();
    });
  }

  async spawnDaemon(): Promise<void> {
    const child = this.spawnProcess(
      process.execPath,
      [this.daemonEntry, ...this.createDaemonEntryArgs()],
      {
        detached: true,
        stdio: "ignore",
      },
    );

    child.unref();
  }

  async waitUntilReady(timeout: number): Promise<MultiplexerDiscoveryInfo> {
    const startedAt = this.now();
    let lastValidation: MultiplexerDiscoveryValidation | null = null;

    while (this.now() - startedAt <= timeout) {
      const validation = this.discovery.validateDiscovery();
      lastValidation = validation;

      if (validation.status === "usable") {
        return validation.info;
      }

      await this.sleepFor(this.readyPollInterval);
    }

    throw new Error(
      `Timed out waiting for multiplexer daemon: ${formatValidation(lastValidation)}`,
    );
  }

  cleanupStaleDaemon(): boolean {
    const validation = this.discovery.validateDiscovery();
    if (validation.status !== "unusable") {
      return false;
    }

    const daemonLockExists = fs.existsSync(this.daemonLock.lockPath);
    if (
      daemonLockExists &&
      !this.daemonLock.isStale(this.staleTimeout, this.now())
    ) {
      return false;
    }

    let cleaned = false;
    if (daemonLockExists) {
      fs.rmSync(this.daemonLock.lockPath, { recursive: true, force: true });
      cleaned = true;
    }

    if (validation.reason !== "missing") {
      cleaned = removeFileIfExists(this.discovery.discoveryPath) || cleaned;
    }

    return cleaned;
  }

  async replaceOutdatedDaemon(
    info: MultiplexerDiscoveryInfo,
    reason: MultiplexerDaemonReplaceReason,
  ): Promise<void> {
    await this.stopDaemonForReplacement(info, reason);
  }

  acquireSpawnLock(): boolean {
    return this.spawnLock.acquire();
  }

  releaseSpawnLock(): void {
    this.spawnLock.release();
  }

  async stopDaemonForReplacement(
    info: MultiplexerDiscoveryInfo,
    reason: MultiplexerDaemonReplaceReason,
  ): Promise<void> {
    const yielded = await this.requestDaemonYield(info, reason);
    if (!yielded) {
      await this.forceStopDaemon(info);
    }
  }

  async requestDaemonYield(
    _info: MultiplexerDiscoveryInfo,
    _reason: MultiplexerDaemonReplaceReason,
  ): Promise<boolean> {
    return false;
  }

  async forceStopDaemon(info: MultiplexerDiscoveryInfo): Promise<void> {
    try {
      this.killProcess(info.pid, "SIGTERM");
    } catch (error: any) {
      if (error?.code !== "ESRCH") {
        throw error;
      }
    }

    await this.sleepFor(this.replacementTimeout);

    try {
      this.killProcess(info.pid, "SIGKILL");
    } catch (error: any) {
      if (error?.code !== "ESRCH") {
        throw error;
      }
    }

    removeFileIfExists(this.discovery.discoveryPath);
    fs.rmSync(this.daemonLock.lockPath, { recursive: true, force: true });
  }

  private async ensureDaemonWithSpawnLock(
    beforeSpawn: () => void | Promise<void>,
  ): Promise<MultiplexerDiscoveryInfo> {
    if (!this.acquireSpawnLock()) {
      return this.waitUntilReady(this.startupTimeout);
    }

    try {
      const validation = this.discovery.validateDiscovery();
      if (validation.status === "usable") {
        return validation.info;
      }

      await beforeSpawn();
      await this.spawnDaemon();
      return this.waitUntilReady(this.startupTimeout);
    } finally {
      this.releaseSpawnLock();
    }
  }

  private createDaemonEntryArgs(): string[] {
    const args = [
      "--discovery-path",
      this.discovery.discoveryPath,
      "--daemon-lock-path",
      this.daemonLock.lockPath,
      "--protocol-version",
      String(this.localProtocolVersion),
      "--control-port",
      String(this.controlPort),
    ];

    if (this.heartbeatInterval !== undefined) {
      args.push("--heartbeat-interval", String(this.heartbeatInterval));
    }

    if (this.daemonVersion) {
      args.push("--daemon-version", this.daemonVersion);
    }

    if (this.capabilities?.length) {
      args.push("--capabilities", this.capabilities.join(","));
    }

    return args;
  }
}

function getDaemonLockPathFromSpawnLock(spawnLockPath: string): string {
  return path.join(path.dirname(spawnLockPath), MULTIPLEXER_DAEMON_LOCK_NAME);
}

function defaultSleep(duration: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, duration));
}

function formatValidation(
  validation: MultiplexerDiscoveryValidation | null,
): string {
  if (!validation) {
    return "no discovery validation result";
  }

  if (validation.status === "usable") {
    return "usable";
  }

  if (validation.status === "replace-required") {
    return `replace-required/${validation.compatibility.reason}`;
  }

  return `unusable/${validation.reason}`;
}
