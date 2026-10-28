// Copyright 2026 The Lynx Authors. All rights reserved.
// Licensed under the Apache License, Version 2.0.

import { Adb, Client as ADBClient } from "@devicefarmer/adbkit";
import AdbConnection from "@devicefarmer/adbkit/dist/src/adb/connection";
import TransportCommand from "@devicefarmer/adbkit/dist/src/adb/command/host/transport";
import ShellCommand from "@devicefarmer/adbkit/dist/src/adb/command/host-transport/shell";
import { Socket } from "net";
import { disposeAdbConnection } from "../../utils/adb.connection";
import { defaultLogger } from "../../utils/logger";
import type { ConnectorError } from "../../utils/type";

type CheckResult = "ready" | "skip" | "pause";

// Owned by AndroidDevice so watcher replacement cannot bypass retry backoff.
// A timeout closes the local request; it cannot guarantee cancellation in adbd.
export class AdbHealthGuard {
  private readonly adb: ADBClient;
  private readonly serial: string;
  private readonly onError?: (error: ConnectorError) => void;
  private readonly responseTimeoutMs: number = 5000;
  private readonly retryDelayMs: number = 5000;
  private closed = false;
  private abort?: AbortController;
  private retryAt = 0;
  private portRetryAt = new Map<number, number>();

  constructor(
    adb: ADBClient,
    serial: string,
    onError?: (error: ConnectorError) => void,
  ) {
    this.adb = adb;
    this.serial = serial;
    this.onError = onError;
  }

  async check(remotePort: number): Promise<CheckResult> {
    if (this.closed || Date.now() < this.retryAt) {
      return "pause";
    }
    if (
      !Number.isInteger(remotePort) ||
      remotePort < 1 ||
      remotePort > 65535 ||
      Date.now() < (this.portRetryAt.get(remotePort) || 0)
    ) {
      return "skip";
    }

    const started = Date.now();
    const abort = new AbortController();
    this.abort = abort;
    let onAbort: () => void;
    const interrupted = new Promise<CheckResult>((resolve) => {
      onAbort = () => resolve("pause");
      abort.signal.addEventListener("abort", onAbort, { once: true });
    });
    const alarm = setTimeout(() => {
      this.retryAt = Date.now() + this.retryDelayMs;
      this.markUnresponsive(started, "response_timeout", remotePort);
      abort.abort();
    }, this.responseTimeoutMs);
    alarm.unref();
    try {
      return await Promise.race([
        this.probe(remotePort, started, abort.signal),
        interrupted,
      ]);
    } finally {
      clearTimeout(alarm);
      abort.signal.removeEventListener("abort", onAbort!);
      if (this.abort === abort) this.abort = undefined;
    }
  }

  private async probe(
    remotePort: number,
    started: number,
    signal: AbortSignal,
  ): Promise<CheckResult> {
    try {
      // TCP connect runs in the phone's short-lived nc process, never in
      // adbd's synchronous tcp: service. -z sends no SDK Initialize payload.
      const result = await this.shell(
        `toybox nc -z -w 2 127.0.0.1 ${remotePort} </dev/null`,
        signal,
      );
      if (signal.aborted) return "pause";

      // Toybox -w reports "nc: Timeout". Do not confuse a refused
      // connection (normal for unused SDK ports) with this timeout or freezing.
      if (result === "nc: Timeout" || result === "netcat: Timeout") {
        this.portRetryAt.set(remotePort, Date.now() + this.retryDelayMs);
        defaultLogger.warn(
          `TCP probe timed out: serial=${this.serial} port=${remotePort}; skipping port`,
        );
        return "skip";
      }

      if (result !== "") {
        defaultLogger.debug(
          `Android TCP preflight failed: serial=${this.serial} port=${remotePort} ${result}`,
        );
      } else if (this.portRetryAt.delete(remotePort)) {
        defaultLogger.info(
          `[ANDROID_SDK_PORT_RESPONSIVE] serial=${this.serial} port=${remotePort}`,
        );
      }
      // Preserve legacy connection behavior when the probe is unsupported or
      // fails for a reason other than an explicit TCP connect timeout.
      return "ready";
    } catch (error) {
      if (!signal.aborted) {
        this.retryAt = Date.now() + this.retryDelayMs;
        this.markUnresponsive(started, String(error), remotePort);
      }
      return "pause";
    }
  }

  close(): void {
    this.closed = true;
    this.abort?.abort();
    this.portRetryAt.clear();
  }

  private async shell(command: string, signal: AbortSignal): Promise<string> {
    if (signal.aborted) throw new Error("ADB probe cancelled");
    const connection = new AdbConnection(this.adb.options);
    // Parser/readAll handles command failures. Retain a listener between stages
    // as adbkit also emits unhandled socket errors on the connection itself.
    connection.on("error", () => {});
    const cancel = () => {
      const socket = connection.getSocket() as Socket | undefined;
      socket?.destroy(new Error("ADB probe cancelled"));
    };
    signal.addEventListener("abort", cancel, { once: true });
    try {
      await connection.connect();
      await new TransportCommand(connection).execute(this.serial);
      if (signal.aborted) throw new Error("ADB probe cancelled");
      const stream = await new ShellCommand(connection).execute(command);
      return (await Adb.util.readAll(stream))
        .toString()
        .replace(/\r/g, "")
        .trim();
    } finally {
      signal.removeEventListener("abort", cancel);
      await disposeAdbConnection(connection);
    }
  }

  private markUnresponsive(
    started: number,
    reason: string,
    remotePort: number,
  ) {
    if (this.closed) return;
    defaultLogger.error(
      `ADB unavailable: serial=${this.serial} port=${remotePort} elapsedMs=${
        Date.now() - started
      } reason=${reason}`,
    );
    this.onError?.({
      code: "ADB_UNRESPONSIVE",
      message:
        "ADB is not responding; try bringing the affected app to the foreground.",
      deviceSerial: this.serial,
    });
  }
}
