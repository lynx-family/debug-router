// Copyright 2024 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

import fs from "fs";
import path from "path";
import { spawn as spawnChildProcess, SpawnOptions } from "child_process";
import { get as httpGet } from "http";
import { MULTIPLEXER_DAEMON_LOCK_NAME } from "../utils/paths";
import { FileLock } from "../utils/FileLock";
import { removeFileIfExists } from "../utils/atomic_file";
import {
  MULTIPLEXER_HEALTH_PATH,
  MULTIPLEXER_MIN_SUPPORTED_PROTOCOL_VERSION,
  MULTIPLEXER_PROTOCOL_VERSION,
  MultiplexerDiscoveryInfo,
} from "../protocol/discovery";
import type { PhysicalConnectorOption } from "../../physical/PhysicalConnector";
import {
  isMultiplexerHealthResponse,
  parseJsonValue,
} from "../protocol/validation";
import type { MultiplexerDaemonClient } from "./MultiplexerDaemonClient";
import {
  MultiplexerDiscovery,
  MultiplexerDiscoveryValidation,
} from "./MultiplexerDiscovery";

export const DEFAULT_MULTIPLEXER_STARTUP_TIMEOUT = 5000;
export const DEFAULT_MULTIPLEXER_READY_POLL_INTERVAL = 100;
export const DEFAULT_MULTIPLEXER_REPLACEMENT_TIMEOUT = 1000;
export const DEFAULT_MULTIPLEXER_HEALTH_CHECK_TIMEOUT = 500;
const DEFAULT_MULTIPLEXER_SPAWN_LOCK_STALE_BUFFER = 1000;
const MULTIPLEXER_HEALTH_RESPONSE_LIMIT = 4096;

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

type MultiplexerDaemonControlClient = Pick<
  MultiplexerDaemonClient,
  "callOnDiscovery"
>;

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
  minSupportedProtocolVersion?: number;
  daemonVersion?: string;
  capabilities?: string[];
  legacyDriverDir?: string;
  multiplexerDaemonIdleTimeout?: number;
  enableWebSocket?: boolean;
  websocketOption?: {
    port?: number;
    roomId?: string;
  };
  physicalConnectorOption?: PhysicalConnectorOption;
  readyPollInterval?: number;
  replacementTimeout?: number;
  healthCheckTimeout?: number;

  // only used for testing
  spawn?: MultiplexerDaemonSpawn;
  kill?: (pid: number, signal: NodeJS.Signals) => void;
  isProcessAlive?: (pid: number) => boolean;
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
  readonly minSupportedProtocolVersion: number;
  readonly daemonVersion?: string;
  readonly capabilities?: string[];
  readonly legacyDriverDir?: string;
  readonly multiplexerDaemonIdleTimeout?: number;
  readonly enableWebSocket?: boolean;
  readonly websocketOption?: {
    port?: number;
    roomId?: string;
  };
  readonly physicalConnectorOption?: PhysicalConnectorOption;
  private readonly readyPollInterval: number;
  private readonly replacementTimeout: number;
  private readonly healthCheckTimeout: number;
  private readonly spawnLockStaleTimeout: number;
  private readonly spawnProcess: MultiplexerDaemonSpawn;
  private readonly killProcess: (pid: number, signal: NodeJS.Signals) => void;
  private readonly isProcessAlive: (pid: number) => boolean;
  private readonly sleepFor: (duration: number) => Promise<void>;
  private readonly now: () => number;
  private daemonClient?: MultiplexerDaemonControlClient;

  constructor(option: MultiplexerDaemonManagerOption) {
    this.discovery = option.discovery;
    this.spawnLock = new FileLock(option.spawnLockPath);
    this.daemonLock = new FileLock(
      option.daemonLockPath ??
        getDaemonLockPathFromSpawnLock(option.spawnLockPath),
    );
    this.daemonEntry = option.daemonEntry;
    this.startupTimeout =
      option.startupTimeout ?? DEFAULT_MULTIPLEXER_STARTUP_TIMEOUT;
    this.staleTimeout = option.staleTimeout ?? this.discovery.staleTimeout;
    this.localProtocolVersion =
      option.localProtocolVersion ?? MULTIPLEXER_PROTOCOL_VERSION;
    this.controlPort = option.controlPort ?? 0;
    this.heartbeatInterval = option.heartbeatInterval;
    this.minSupportedProtocolVersion =
      option.minSupportedProtocolVersion ??
      MULTIPLEXER_MIN_SUPPORTED_PROTOCOL_VERSION;
    this.daemonVersion = option.daemonVersion;
    this.capabilities = option.capabilities;
    this.legacyDriverDir = option.legacyDriverDir;
    this.multiplexerDaemonIdleTimeout = option.multiplexerDaemonIdleTimeout;
    this.enableWebSocket = option.enableWebSocket;
    this.websocketOption = option.websocketOption;
    this.physicalConnectorOption = option.physicalConnectorOption;
    this.readyPollInterval =
      option.readyPollInterval ?? DEFAULT_MULTIPLEXER_READY_POLL_INTERVAL;
    this.replacementTimeout =
      option.replacementTimeout ?? DEFAULT_MULTIPLEXER_REPLACEMENT_TIMEOUT;
    this.healthCheckTimeout =
      option.healthCheckTimeout ?? DEFAULT_MULTIPLEXER_HEALTH_CHECK_TIMEOUT;
    this.spawnLockStaleTimeout =
      this.startupTimeout +
      this.replacementTimeout +
      DEFAULT_MULTIPLEXER_SPAWN_LOCK_STALE_BUFFER;
    this.spawnProcess = option.spawn ?? spawnChildProcess;
    this.killProcess = option.kill ?? process.kill;
    this.isProcessAlive = option.isProcessAlive ?? isProcessAlive;
    this.sleepFor = option.sleep ?? defaultSleep;
    this.now = option.now ?? Date.now;
  }

  setDaemonClient(daemonClient: MultiplexerDaemonControlClient): void {
    this.daemonClient = daemonClient;
  }

  async ensureDaemon(): Promise<MultiplexerDiscoveryInfo> {
    return this.handleDiscoveryValidation(this.discovery.validateDiscovery());
  }

  async handleDiscoveryValidation(
    validation: MultiplexerDiscoveryValidation,
  ): Promise<MultiplexerDiscoveryInfo> {
    if (validation.status === "usable") {
      const healthCheck = await this.checkDaemonHealth(validation.info);
      if (healthCheck.ok) {
        return validation.info;
      }

      return this.ensureDaemonWithSpawnLock(async () => {
        await this.waitUntilUnhealthyDaemonCanSpawn(
          validation.info,
          this.startupTimeout,
        );
      });
    }

    if (validation.status === "replace-required") {
      return this.ensureDaemonWithSpawnLock(async () => {
        await this.replaceOutdatedDaemon(
          validation.info,
          "daemon-protocol-older-than-connector",
        );
      });
    }

    if (isConnectorProtocolTooOld(validation)) {
      throw createConnectorUpgradeError(validation);
    }

    return this.ensureDaemonWithSpawnLock(async () => {
      await this.waitUntilUnusableDaemonCanSpawn(this.startupTimeout);
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
    let lastHealthCheckFailure: string | null = null;

    while (this.now() - startedAt <= timeout) {
      const validation = this.discovery.validateDiscovery();
      lastValidation = validation;

      if (validation.status === "usable") {
        const healthCheck = await this.checkDaemonHealth(validation.info);
        if (healthCheck.ok) {
          return validation.info;
        }

        lastHealthCheckFailure = healthCheck.reason;
      }

      await this.sleepFor(this.readyPollInterval);
    }

    throw new Error(
      `Timed out waiting for multiplexer daemon: ${formatValidation(
        lastValidation,
      )}${formatHealthCheckFailure(lastHealthCheckFailure)}`,
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
    this.spawnLock.cleanupStale(this.spawnLockStaleTimeout, this.now());
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
    this.removeDaemonArtifacts();
  }

  async requestDaemonYield(
    info: MultiplexerDiscoveryInfo,
    reason: MultiplexerDaemonReplaceReason,
  ): Promise<boolean> {
    const requested = await this.sendDaemonShutdownRpc(info, reason);
    if (!requested) {
      return false;
    }

    return this.waitUntilProcessExits(info.pid, this.replacementTimeout);
  }

  async forceStopDaemon(info: MultiplexerDiscoveryInfo): Promise<void> {
    const sigtermError = this.tryKillProcess(info.pid, "SIGTERM");
    await this.waitUntilProcessExits(info.pid, this.replacementTimeout);

    let sigkillError: unknown = null;
    if (this.isProcessAlive(info.pid)) {
      sigkillError = this.tryKillProcess(info.pid, "SIGKILL");
      await this.waitUntilProcessExits(info.pid, this.replacementTimeout);
    }

    const processAlive = this.isProcessAlive(info.pid);
    if (!processAlive) {
      this.removeDaemonArtifacts();
      return;
    }

    const unexpectedSigkillError = getUnexpectedKillError(sigkillError);
    if (unexpectedSigkillError) {
      throw unexpectedSigkillError;
    }

    const unexpectedSigtermError = getUnexpectedKillError(sigtermError);
    if (unexpectedSigtermError) {
      throw unexpectedSigtermError;
    }
    throw new Error(`Failed to stop multiplexer daemon ${info.pid}`);
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
        const healthCheck = await this.checkDaemonHealth(validation.info);
        if (healthCheck.ok) {
          return validation.info;
        }
      }

      await beforeSpawn();
      await this.spawnDaemon();
      return this.waitUntilReady(this.startupTimeout);
    } finally {
      this.releaseSpawnLock();
    }
  }

  private async waitUntilUnusableDaemonCanSpawn(
    timeout: number,
  ): Promise<void> {
    const startedAt = this.now();

    while (this.now() - startedAt <= timeout) {
      const daemonLockExists = fs.existsSync(this.daemonLock.lockPath);
      if (
        !daemonLockExists ||
        this.daemonLock.isStale(this.staleTimeout, this.now())
      ) {
        this.cleanupStaleDaemon();
        return;
      }

      const validation = this.discovery.validateDiscovery();
      if (validation.status !== "unusable") {
        return;
      }

      await this.sleepFor(this.readyPollInterval);
    }
  }

  private async waitUntilUnhealthyDaemonCanSpawn(
    info: MultiplexerDiscoveryInfo,
    timeout: number,
  ): Promise<void> {
    const startedAt = this.now();

    while (this.now() - startedAt <= timeout) {
      const daemonLockExists = fs.existsSync(this.daemonLock.lockPath);
      if (
        !daemonLockExists ||
        this.daemonLock.isStale(this.staleTimeout, this.now())
      ) {
        this.cleanupKnownUnhealthyDaemon();
        return;
      }

      const validation = this.discovery.validateDiscovery();
      if (
        validation.status !== "usable" ||
        validation.info.pid !== info.pid ||
        validation.info.controlPort !== info.controlPort
      ) {
        await this.waitUntilUnusableDaemonCanSpawn(
          Math.max(0, timeout - (this.now() - startedAt)),
        );
        return;
      }

      await this.sleepFor(this.readyPollInterval);
    }
  }

  private cleanupKnownUnhealthyDaemon(): void {
    removeFileIfExists(this.discovery.discoveryPath);
    fs.rmSync(this.daemonLock.lockPath, { recursive: true, force: true });
  }

  private removeDaemonArtifacts(): void {
    removeFileIfExists(this.discovery.discoveryPath);
    fs.rmSync(this.daemonLock.lockPath, { recursive: true, force: true });
  }

  private tryKillProcess(pid: number, signal: NodeJS.Signals): unknown {
    try {
      this.killProcess(pid, signal);
      return null;
    } catch (error: any) {
      return error;
    }
  }

  private async waitUntilProcessExits(
    pid: number,
    timeout: number,
  ): Promise<boolean> {
    const startedAt = this.now();

    while (this.now() - startedAt <= timeout) {
      if (!this.isProcessAlive(pid)) {
        return true;
      }
      await this.sleepFor(this.readyPollInterval);
    }

    return !this.isProcessAlive(pid);
  }

  private sendDaemonShutdownRpc(
    info: MultiplexerDiscoveryInfo,
    reason: MultiplexerDaemonReplaceReason,
  ): Promise<boolean> {
    if (
      !Number.isInteger(info.controlPort) ||
      info.controlPort <= 0 ||
      info.controlPort > 65535
    ) {
      return Promise.resolve(false);
    }

    if (!this.daemonClient) {
      return Promise.resolve(false);
    }

    return this.daemonClient
      .callOnDiscovery(info, "shutdownDaemon", { reason })
      .then(
        () => true,
        () => false,
      );
  }

  private createDaemonEntryArgs(): string[] {
    const args = [
      "--discovery-path",
      this.discovery.discoveryPath,
      "--daemon-lock-path",
      this.daemonLock.lockPath,
      "--protocol-version",
      String(this.localProtocolVersion),
      "--min-supported-protocol-version",
      String(this.minSupportedProtocolVersion),
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

    if (this.legacyDriverDir) {
      args.push("--legacy-driver-dir", this.legacyDriverDir);
    }

    if (this.multiplexerDaemonIdleTimeout !== undefined) {
      args.push(
        "--multiplexer-daemon-idle-timeout",
        String(this.multiplexerDaemonIdleTimeout),
      );
    }

    if (this.enableWebSocket !== undefined) {
      args.push("--enable-websocket", String(this.enableWebSocket));
    }

    if (this.websocketOption?.port !== undefined) {
      args.push("--websocket-port", String(this.websocketOption.port));
    }

    if (this.websocketOption?.roomId !== undefined) {
      args.push("--websocket-room-id", this.websocketOption.roomId);
    }

    if (this.physicalConnectorOption !== undefined) {
      args.push(
        "--physical-connector-option",
        JSON.stringify(this.physicalConnectorOption),
      );
    }

    return args;
  }

  private checkDaemonHealth(
    info: MultiplexerDiscoveryInfo,
  ): Promise<{ ok: true } | { ok: false; reason: string }> {
    if (
      !Number.isInteger(info.controlPort) ||
      info.controlPort <= 0 ||
      info.controlPort > 65535
    ) {
      return Promise.resolve({
        ok: false,
        reason: `invalid-control-port:${info.controlPort}`,
      });
    }

    return new Promise((resolve) => {
      let settled = false;
      const finish = (result: { ok: true } | { ok: false; reason: string }) => {
        if (settled) {
          return;
        }

        settled = true;
        resolve(result);
      };

      const request = httpGet(
        {
          host: "127.0.0.1",
          port: info.controlPort,
          path: MULTIPLEXER_HEALTH_PATH,
          timeout: this.healthCheckTimeout,
        },
        (response) => {
          if (response.statusCode !== 200) {
            response.resume();
            finish({
              ok: false,
              reason: `status:${response.statusCode ?? "unknown"}`,
            });
            return;
          }

          response.setEncoding("utf8");
          let body = "";
          response.on("data", (chunk) => {
            body += chunk;
            if (body.length > MULTIPLEXER_HEALTH_RESPONSE_LIMIT) {
              finish({
                ok: false,
                reason: "multiplexer health response is too large",
              });
              response.destroy();
              request.destroy();
            }
          });
          response.on("error", (error) => {
            finish({ ok: false, reason: error.message });
          });
          response.on("end", () => {
            const value = parseJsonValue(body);
            if (!isMultiplexerHealthResponse(value)) {
              finish({ ok: false, reason: "invalid-health-response" });
              return;
            }

            if (value.pid !== info.pid) {
              finish({ ok: false, reason: "pid-mismatch" });
              return;
            }

            if (value.protocolVersion !== info.protocolVersion) {
              finish({ ok: false, reason: "protocol-version-mismatch" });
              return;
            }

            finish({ ok: true });
          });
        },
      );

      request.on("timeout", () => {
        request.destroy(new Error("multiplexer health check timed out"));
      });
      request.on("error", (error) => {
        finish({ ok: false, reason: error.message });
      });
    });
  }

  private async hasDaemonYielded(
    info: MultiplexerDiscoveryInfo,
  ): Promise<boolean> {
    const healthCheck = await this.checkDaemonHealth(info);
    return !healthCheck.ok;
  }
}

function getDaemonLockPathFromSpawnLock(spawnLockPath: string): string {
  return path.join(path.dirname(spawnLockPath), MULTIPLEXER_DAEMON_LOCK_NAME);
}

function defaultSleep(duration: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, duration));
}

function getUnexpectedKillError(error: unknown): Error | null {
  if (!error || (error as any)?.code === "ESRCH") {
    return null;
  }

  return error instanceof Error ? error : new Error(String(error));
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch (error: any) {
    return error?.code === "EPERM";
  }
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

  if (isConnectorProtocolTooOld(validation)) {
    return `unusable/${validation.reason}`;
  }

  return `unusable/${validation.reason}`;
}

function formatHealthCheckFailure(reason: string | null): string {
  return reason ? `, health-check:${reason}` : "";
}

function isConnectorProtocolTooOld(
  validation: MultiplexerDiscoveryValidation,
): validation is Extract<
  MultiplexerDiscoveryValidation,
  { status: "unusable"; reason: "connector-protocol-too-old" }
> {
  return (
    validation.status === "unusable" &&
    validation.reason === "connector-protocol-too-old" &&
    !!validation.compatibility
  );
}

function createConnectorUpgradeError(
  validation: Extract<
    MultiplexerDiscoveryValidation,
    { status: "unusable"; reason: "connector-protocol-too-old" }
  >,
): Error {
  const compatibility = validation.compatibility;
  return new Error(
    `Multiplexer daemon requires debug-router-connector protocol ` +
      `${compatibility.daemonMinSupportedProtocolVersion} or newer, ` +
      `but current connector protocol is ` +
      `${compatibility.connectorProtocolVersion}. Please upgrade ` +
      `@lynx-js/debug-router-connector.`,
  );
}
