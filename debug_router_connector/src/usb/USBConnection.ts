// Copyright 2024 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

import * as net from "net";
import { RequireMessageType, ResponseMessageType } from "../utils/type";
import { Connection } from "./Connection";
import { packMessage } from "./utils";
import { defaultLogger } from "../utils/logger";
import type { ConnectionTraceRecorder } from "../trace/ConnectionTraceRecorder";

type UsbConnectionTraceContext = {
  recorder?: ConnectionTraceRecorder | null;
  deviceId?: string;
  port?: number;
  clientId?: number;
  connectionAttemptId?: string;
};

export class USBConnection extends Connection {
  private traceContext: UsbConnectionTraceContext;
  private closed = false;

  constructor(
    protected socket: net.Socket,
    traceContext: UsbConnectionTraceContext = {},
  ) {
    super();
    this.traceContext = traceContext;
    this.socket.on("error", (error) => {
      this.rejectAllPendingRequests(error);
    });
    this.socket.on("close", () => {
      this.rejectAllPendingRequests(new Error("USB connection closed"));
    });
  }

  setTraceClientId(clientId: number) {
    this.traceContext = { ...this.traceContext, clientId };
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    defaultLogger.debug("USBConnection: close");
    this.rejectAllPendingRequests(new Error("USB connection closed"));
    this.traceContext.recorder?.recordUsbConnectionClosed({
      deviceId: this.traceContext.deviceId,
      port: this.traceContext.port,
      clientId: this.traceContext.clientId,
      connectionAttemptId: this.traceContext.connectionAttemptId,
    });
    this.socket.end();
  }

  send(data: any): void {
    if (this.socket.writable) {
      if (process.env.PrintAllUSBMessage === "enable") {
        defaultLogger.info("[Send]:" + JSON.stringify(data));
      }
      this.socket.write(packMessage(data));
    }
  }
  sendExpectResponse(
    require: RequireMessageType,
    timeoutMs?: number,
  ): Promise<ResponseMessageType> {
    if (!this.socket.writable) {
      return Promise.reject(new Error("USB socket is not writable"));
    }

    let key: string | undefined;
    if (require.event === "Initialize") {
      key = require.event;
    } else if (require.event === "Customized") {
      const data = require.data;
      key =
        data.type === "CDP" || data.type === "App"
          ? data.data.message.id.toString()
          : data.type;
    }
    if (!key) {
      return Promise.reject(
        new Error(`Unsupported response event: ${require.event}`),
      );
    }

    if (this.pendingRequests.has(key)) {
      return Promise.reject(new Error(`Request ${key} is already pending`));
    }
    const pending = this.pendingRequests.register(key, timeoutMs);
    try {
      this.send(require);
    } catch (error: any) {
      this.pendingRequests.reject(
        key,
        error instanceof Error ? error : new Error(String(error)),
      );
    }
    return pending;
  }
}
