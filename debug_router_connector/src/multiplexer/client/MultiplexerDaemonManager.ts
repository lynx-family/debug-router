// Copyright 2026 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

import {
  execFileSync,
  spawn as spawnChildProcess,
  SpawnOptions,
} from "child_process";
import findProcess from "find-process";
import fs from "fs";
import { defaultLogger } from "../../utils/logger";
import { FileLock } from "../utils/FileLock";
import { MULTIPLEXER_PROTOCOL_VERSION } from "../protocol/control";
import type { MultiplexerDebugInfo } from "../protocol/debuginfo";
import type { PhysicalConnectorOption } from "../../physical/PhysicalConnector";
import type { ConnectionTraceOptions } from "../../trace/ConnectionTraceRecorder";
import {
  MultiplexerDiscovery,
  MultiplexerDiscoveryValidation,
} from "./MultiplexerDiscovery";

export const DEFAULT_MULTIPLEXER_STARTUP_TIMEOUT = 5000;
export const DEFAULT_MULTIPLEXER_READY_POLL_INTERVAL = 50;
export const DEFAULT_MULTIPLEXER_REPLACEMENT_TIMEOUT = 1000;
const DEFAULT_MULTIPLEXER_SPAWN_LOCK_STALE_BUFFER = 1000;
const MULTIPLEXER_HEALTH_PROBE_RETRY_COUNT = 3;

export type MultiplexerDaemonReplaceReason =
  | "daemon-protocol-older-than-connector"
  | "force-respawn"
  | "force-stop";

export type SpawnedDaemonProcess = {
  unref(): void;
};

export type MultiplexerDaemonSpawn = (
  command: string,
  args: string[],
  options: SpawnOptions,
) => SpawnedDaemonProcess;

type MultiplexerDaemonControlClient = {
  call(
    method: "shutdownDaemon",
    params: { reason?: string },
    ensureDaemon?: boolean,
  ): Promise<unknown>;
};

export type MultiplexerDaemonManagerOption = {
  // Required daemon lifecycle dependencies.
  discovery: MultiplexerDiscovery;
  daemonProcessName: string;
  controlEndpoint: string;
  spawnLockPath: string;
  daemonEntry: string;
  multiplexerDaemonIdleTimeout: number;

  // Optional manager tuning with constructor defaults.
  startupTimeout?: number;
  localProtocolVersion?: number;
  forceRespawnDaemon?: boolean;
  readyPollInterval?: number;
  replacementTimeout?: number;

  // Optional daemon startup arguments. Undefined omits the corresponding
  // argument so the daemon or Host can apply its own default behavior.
  debugInfo?: MultiplexerDebugInfo;
  legacyDriverDir?: string;
  enableWebSocket?: boolean;
  connectionTrace?: ConnectionTraceOptions;
  websocketOption?: {
    port?: number;
    roomId?: string;
  };
  physicalConnectorOption?: PhysicalConnectorOption;

  // only used for testing
  spawn?: MultiplexerDaemonSpawn;
  kill?: (pid: number, signal: NodeJS.Signals) => void;
  isProcessAlive?: (pid: number) => boolean;
  sleep?: (duration: number) => Promise<void>;
  now?: () => number;
};

export class MultiplexerDaemonManager {
  readonly discovery: MultiplexerDiscovery;
  readonly daemonProcessName: string;
  readonly controlEndpoint: string;
  readonly spawnLock: FileLock;
  readonly daemonEntry: string;
  readonly startupTimeout: number;
  readonly localProtocolVersion: number;
  readonly debugInfo?: MultiplexerDebugInfo;
  readonly legacyDriverDir?: string;
  readonly multiplexerDaemonIdleTimeout: number;
  readonly enableWebSocket?: boolean;
  readonly connectionTrace?: ConnectionTraceOptions;
  readonly websocketOption?: {
    port?: number;
    roomId?: string;
  };
  readonly physicalConnectorOption?: PhysicalConnectorOption;

  private readonly readyPollInterval: number;
  private readonly replacementTimeout: number;
  private readonly spawnLockStaleTimeout: number;
  private readonly spawnProcess: MultiplexerDaemonSpawn;
  private readonly killProcess: (pid: number, signal: NodeJS.Signals) => void;
  private readonly isProcessAlive: (pid: number) => boolean;
  private readonly sleepFor: (duration: number) => Promise<void>;
  private readonly now: () => number;
  private forceRespawnDaemonPending: boolean;
  private daemonClient?: MultiplexerDaemonControlClient;

  constructor(option: MultiplexerDaemonManagerOption) {
    this.discovery = option.discovery;
    this.daemonProcessName = option.daemonProcessName;
    this.controlEndpoint = option.controlEndpoint;
    this.spawnLock = new FileLock(option.spawnLockPath);
    this.daemonEntry = option.daemonEntry;
    this.startupTimeout =
      option.startupTimeout ?? DEFAULT_MULTIPLEXER_STARTUP_TIMEOUT;
    this.localProtocolVersion =
      option.localProtocolVersion ?? MULTIPLEXER_PROTOCOL_VERSION;
    this.debugInfo = option.debugInfo;
    this.legacyDriverDir = option.legacyDriverDir;
    this.multiplexerDaemonIdleTimeout = option.multiplexerDaemonIdleTimeout;
    this.forceRespawnDaemonPending = option.forceRespawnDaemon ?? false;
    this.enableWebSocket = option.enableWebSocket;
    this.connectionTrace = option.connectionTrace;
    this.websocketOption = option.websocketOption;
    this.physicalConnectorOption = option.physicalConnectorOption;
    this.readyPollInterval =
      option.readyPollInterval ?? DEFAULT_MULTIPLEXER_READY_POLL_INTERVAL;
    this.replacementTimeout =
      option.replacementTimeout ?? DEFAULT_MULTIPLEXER_REPLACEMENT_TIMEOUT;
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

  async stopDaemonForDebugging(): Promise<void> {
    while (!this.acquireSpawnLock()) {
      await this.sleepFor(this.readyPollInterval);
    }

    try {
      const validation = await this.probeDaemonHealthWithRetry();
      if (
        validation.status === "usable" ||
        validation.status === "replace-required"
      ) {
        await this.tryGracefullyStopDaemon("force-stop");
      } else {
        await this.forceStopDaemon();
      }
    } finally {
      this.releaseSpawnLock();
    }
  }

  async ensureDaemon(): Promise<void> {
    if (this.forceRespawnDaemonPending) {
      return this.forceRespawnDaemon();
    }

    while (true) {
      const validation = await this.probeDaemonHealthWithRetry();
      if (await this.handleDiscoveryResult(validation)) return;
      // If another connector process has spawned an unavailable daemon, retry ensureDaemon.
    }
  }

  async handleDiscoveryResult(
    validation: MultiplexerDiscoveryValidation,
  ): Promise<boolean> {
    if (validation.status === "usable") {
      return true;
    }
    if (validation.status === "replace-required") {
      return this.tryStartDaemon(async () => {
        await this.tryGracefullyStopDaemon(
          "daemon-protocol-older-than-connector",
        );
      });
    }
    if (isOlderDaemonInUse(validation)) {
      throw createOlderDaemonInUseError(validation);
    }
    return this.tryStartDaemon(async () => {
      await this.forceStopDaemon();
    });
  }

  private async tryStartDaemon(
    beforeSpawn: () => void | Promise<void>,
  ): Promise<boolean> {
    if (!this.acquireSpawnLock()) {
      return false;
    }

    try {
      await beforeSpawn();
      await this.spawnDaemon();
      await this.waitUntilReady(this.startupTimeout);
      return true;
    } finally {
      this.releaseSpawnLock();
    }
  }

  async spawnDaemon(): Promise<void> {
    const child = this.spawnProcess(
      process.execPath,
      [this.daemonEntry, ...this.createDaemonEntryArgs()],
      {
        argv0: this.daemonProcessName,
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      },
    );
    child.unref();
  }

  async waitUntilReady(timeout: number): Promise<void> {
    const startedAt = this.now();
    let lastValidation: MultiplexerDiscoveryValidation | null = null;
    let lastHealthCheckFailure: string | null = null;

    while (this.now() - startedAt <= timeout) {
      const validation = await this.discovery.probeHealth();
      lastValidation = validation;
      if (validation.status === "usable") {
        return;
      }
      if (validation.status === "replace-required") {
        throw createDaemonReplacementRequiredError(validation);
      }
      if (isOlderDaemonInUse(validation)) {
        throw createOlderDaemonInUseError(validation);
      }
      lastHealthCheckFailure = validation.error?.message ?? null;
      await this.sleepFor(this.readyPollInterval);
    }

    throw new Error(
      `Timed out waiting for multiplexer daemon: ${formatValidation(
        lastValidation,
      )}${
        lastHealthCheckFailure ? `, health-check:${lastHealthCheckFailure}` : ""
      }`,
    );
  }

  async tryGracefullyStopDaemon(
    reason: MultiplexerDaemonReplaceReason,
  ): Promise<void> {
    const daemonPid = await this.findDaemonProcessId();
    const requested = await this.sendDaemonShutdownRpc(reason);

    if (daemonPid === -1) {
      defaultLogger.error(
        `Failed to find multiplexer daemon process during trying graceful shutdown: ${this.daemonProcessName}`,
      );
      return;
    }
    if (requested) {
      await this.waitUntilProcessExits(daemonPid, this.replacementTimeout);
    }
    if (this.isProcessAlive(daemonPid)) {
      await this.forceStopProcess(daemonPid);
    }
    this.removeDaemonArtifacts();
  }

  private sendDaemonShutdownRpc(
    reason: MultiplexerDaemonReplaceReason,
  ): Promise<boolean> {
    if (!this.daemonClient) {
      return Promise.resolve(false);
    }
    return this.daemonClient.call("shutdownDaemon", { reason }, false).then(
      () => true,
      () => false,
    );
  }

  private async forceStopProcess(pid: number): Promise<void> {
    const sigtermError = this.tryKillProcess(pid, "SIGTERM");
    if ((sigtermError as any)?.code === "ESRCH") {
      return;
    }
    await this.waitUntilProcessExits(pid, this.replacementTimeout);

    let sigkillError: unknown = null;
    if (this.isProcessAlive(pid)) {
      sigkillError = this.tryKillProcess(pid, "SIGKILL");
      if ((sigkillError as any)?.code === "ESRCH") {
        return;
      }
      await this.waitUntilProcessExits(pid, this.replacementTimeout);
    }
    if (!this.isProcessAlive(pid)) {
      return;
    }
    if (sigkillError && (sigkillError as any)?.code !== "ESRCH") {
      throw asError(sigkillError);
    }
    if (sigtermError && (sigtermError as any)?.code !== "ESRCH") {
      throw asError(sigtermError);
    }
    throw new Error(`Failed to stop multiplexer daemon ${pid}`);
  }

  private async forceStopDaemon(): Promise<void> {
    const daemonPid = await this.findDaemonProcessId();
    if (daemonPid !== -1 && this.isProcessAlive(daemonPid)) {
      await this.forceStopProcess(daemonPid);
    }
    this.removeDaemonArtifacts();
  }

  private async findDaemonProcessId(): Promise<number> {
    let daemonProcessIds: number[];
    if (process.platform === "win32") {
      const processes = await findProcess(
        "name",
        this.daemonProcessName,
        false,
      );
      daemonProcessIds = processes.map((daemonProcess) => daemonProcess.pid);
    } else {
      try {
        daemonProcessIds = execFileSync(
          "pgrep",
          ["-f", `^${this.daemonProcessName}([[:space:]]|$)`],
          { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
        )
          .trim()
          .split(/\s+/)
          .filter(Boolean)
          .map(Number);
      } catch (_error) {
        daemonProcessIds = [];
      }
    }
    if (daemonProcessIds.length > 1) {
      defaultLogger.error(
        `Found multiple multiplexer daemon processes for ${
          this.daemonProcessName
        }: ${daemonProcessIds.join(", ")}`,
      );
    }
    return daemonProcessIds.length === 0 ? -1 : daemonProcessIds[0];
  }

  private tryKillProcess(pid: number, signal: NodeJS.Signals): unknown {
    try {
      this.killProcess(pid, signal);
      return null;
    } catch (error) {
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

  private async probeDaemonHealthWithRetry(): Promise<MultiplexerDiscoveryValidation> {
    let validation = await this.discovery.probeHealth();

    for (
      let attempt = 0;
      attempt < MULTIPLEXER_HEALTH_PROBE_RETRY_COUNT &&
      isRetryableHealthProbeResult(validation);
      attempt++
    ) {
      await this.sleepFor(this.readyPollInterval);
      validation = await this.discovery.probeHealth();
    }

    return validation;
  }

  private async forceRespawnDaemon(): Promise<void> {
    // forceRespawnDaemon is intended for testing only and does not support
    // concurrent use. Running multiple Connector facades with
    // forceRespawnDaemon enabled at the same time may lead to undefined
    // behavior and should be avoided.

    while (!this.acquireSpawnLock()) {
      await this.sleepFor(this.readyPollInterval);
    }

    try {
      this.forceRespawnDaemonPending = false;
      const validation = await this.probeDaemonHealthWithRetry();
      if (
        validation.status === "usable" ||
        validation.status === "replace-required"
      ) {
        await this.tryGracefullyStopDaemon("force-respawn");
      } else {
        await this.forceStopDaemon();
      }
      await this.spawnDaemon();
      return this.waitUntilReady(this.startupTimeout);
    } finally {
      this.releaseSpawnLock();
    }
  }

  acquireSpawnLock(): boolean {
    this.spawnLock.cleanupStale(this.spawnLockStaleTimeout, this.now());
    return this.spawnLock.acquire();
  }

  releaseSpawnLock(): void {
    this.spawnLock.release();
  }

  private removeDaemonArtifacts(): void {
    if (process.platform !== "win32") {
      try {
        fs.rmSync(this.controlEndpoint, { force: true });
      } catch (_error) {
        // A stale Unix socket is best-effort cleanup after its owner is gone.
      }
    }
  }

  private createDaemonEntryArgs(): string[] {
    const args = [
      "--control-endpoint",
      this.controlEndpoint,
      "--protocol-version",
      String(this.localProtocolVersion),
      "--multiplexer-daemon-idle-timeout",
      String(this.multiplexerDaemonIdleTimeout),
    ];

    if (this.debugInfo) {
      args.push("--debug-info", JSON.stringify(this.debugInfo));
    }
    if (this.legacyDriverDir !== undefined) {
      args.push("--legacy-driver-dir", this.legacyDriverDir);
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
    if (this.connectionTrace !== undefined) {
      args.push("--connection-trace", JSON.stringify(this.connectionTrace));
    }
    if (this.physicalConnectorOption !== undefined) {
      args.push(
        "--physical-connector-option",
        JSON.stringify(this.physicalConnectorOption),
      );
    }
    return args;
  }
}

function defaultSleep(duration: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, duration));
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
    return "no health result";
  }
  return `${validation.status}/${validation.reason}`;
}

function isRetryableHealthProbeResult(
  validation: MultiplexerDiscoveryValidation,
): boolean {
  return (
    validation.status === "unusable" &&
    (validation.reason === "unreachable" ||
      validation.reason === "timeout" ||
      validation.reason === "invalid-frame" ||
      validation.reason === "invalid-response")
  );
}

function isOlderDaemonInUse(
  validation: MultiplexerDiscoveryValidation,
): validation is Extract<
  MultiplexerDiscoveryValidation,
  {
    status: "unusable";
    reason: "daemon-upgrade-blocked-by-active-connections";
  }
> {
  return (
    validation.status === "unusable" &&
    validation.reason === "daemon-upgrade-blocked-by-active-connections"
  );
}

function createOlderDaemonInUseError(
  validation: Extract<
    MultiplexerDiscoveryValidation,
    {
      status: "unusable";
      reason: "daemon-upgrade-blocked-by-active-connections";
    }
  >,
): Error {
  return new Error(
    `Multiplexer daemon protocol ${validation.daemonProtocolVersion} is older ` +
      `than current connector protocol ${validation.connectorProtocolVersion}, ` +
      `but the daemon is still in use by a connector or WebSocket frontend`,
  );
}

function createDaemonReplacementRequiredError(
  validation: Extract<
    MultiplexerDiscoveryValidation,
    { status: "replace-required" }
  >,
): Error {
  return new Error(
    `Multiplexer daemon protocol ${validation.daemonProtocolVersion} is older ` +
      `than current connector protocol ${validation.connectorProtocolVersion}`,
  );
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
