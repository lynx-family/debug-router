// Copyright 2026 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

import { FileLock } from "../utils/FileLock";

export type MultiplexerDaemonHost = {
  start: (option?: unknown) => void | Promise<void>;
  stop: () => void | Promise<void>;
  setIdleTimeoutHandler?: (handler: () => void | Promise<void>) => void;
  setShutdownHandler?: (handler: () => void | Promise<void>) => void;
};

export type MultiplexerDaemonOption = {
  daemonLockPath: string;
  host: MultiplexerDaemonHost;
  hostOption?: unknown;
  onIdleTimeout?: (stopError?: unknown) => void | Promise<void>;
  onShutdownRequest?: (stopError?: unknown) => void | Promise<void>;
};

export class MultiplexerDaemon {
  daemonLock: FileLock;
  host: MultiplexerDaemonHost;

  private readonly option: MultiplexerDaemonOption;
  private started = false;
  private hostStarted = false;

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
      this.started = true;
    } catch (error) {
      await this.stop();
      throw error;
    }
  }

  async stop(): Promise<void> {
    let hostStopError: unknown;
    try {
      await this.stopHost();
    } catch (error) {
      hostStopError = error;
    }

    this.releaseDaemonLock();
    this.started = false;
    if (hostStopError) {
      throw hostStopError;
    }
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

  private async startHost(): Promise<void> {
    if (this.hostStarted) {
      return;
    }
    this.host.setIdleTimeoutHandler?.(this.handleHostIdleTimeout);
    this.host.setShutdownHandler?.(this.handleHostShutdownRequest);
    await this.host.start(this.option.hostOption);
    this.hostStarted = true;
  }

  private async stopHost(): Promise<void> {
    if (!this.hostStarted) {
      return;
    }
    await this.host.stop();
    this.hostStarted = false;
  }

  private async stopForHostRequest(
    onStopped?: (stopError?: unknown) => void | Promise<void>,
  ): Promise<void> {
    let stopError: unknown;
    try {
      await this.stop();
    } catch (error) {
      stopError = error;
    }

    try {
      await onStopped?.(stopError);
    } catch (_error) {
      // Process-level cleanup handlers will retry stop on exit paths.
    }
  }

  private readonly handleHostIdleTimeout = async (): Promise<void> => {
    await this.stopForHostRequest(this.option.onIdleTimeout);
  };

  private readonly handleHostShutdownRequest = async (): Promise<void> => {
    await this.stopForHostRequest(this.option.onShutdownRequest);
  };
}
