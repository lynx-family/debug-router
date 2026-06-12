// Copyright 2024 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

import { WebSocket } from "ws";
import type { RawData } from "ws";
import {
  ControlRpcError,
  ControlRpcRequest,
  ControlRpcResponse,
} from "../protocol/control";
import { ControlEvent } from "../protocol/event";
import {
  isControlRpcRequest,
  isNumber,
  isRecord,
  parseJsonValue,
} from "../protocol/validation";

const INVALID_MESSAGE_RPC_ID = -1;

export type MultiplexerControlConnectionOption = {
  controlId: number;
  socket: WebSocket;
  onMessage: (
    controlId: number,
    message: ControlRpcRequest,
  ) => void | Promise<void>;
  onClose: (controlId: number) => void;
};

export class MultiplexerControlConnection {
  readonly controlId: number;
  readonly socket: WebSocket;
  private readonly onMessage: (
    controlId: number,
    message: ControlRpcRequest,
  ) => void | Promise<void>;
  private readonly onClose: (controlId: number) => void;
  private subscribedValue = true;
  private closedValue = false;

  constructor(option: MultiplexerControlConnectionOption) {
    this.controlId = option.controlId;
    this.socket = option.socket;
    this.onMessage = option.onMessage;
    this.onClose = option.onClose;

    this.socket.on("message", this.handleSocketMessage);
    this.socket.on("close", this.handleClose);
  }

  get subscribed(): boolean {
    return this.subscribedValue;
  }

  get closed(): boolean {
    return this.closedValue;
  }

  send(message: ControlEvent | ControlRpcResponse): void {
    if (!this.canSend()) {
      return;
    }

    if (message.kind === "event" && !this.subscribed) {
      return;
    }

    this.socket.send(JSON.stringify(message));
  }

  sendResponse(rpcId: number, result: unknown): void {
    this.send({
      kind: "rpc-response",
      id: rpcId,
      ok: true,
      result,
    } as ControlRpcResponse);
  }

  sendError(rpcId: number, error: ControlRpcError): void {
    this.send({
      kind: "rpc-response",
      id: rpcId,
      ok: false,
      error,
    });
  }

  handleMessage(message: ControlRpcRequest): void {
    if (this.closed) {
      return;
    }

    try {
      const result = this.onMessage(this.controlId, message);
      if (result) {
        result.catch((error) => {
          this.sendError(message.id, createDispatchError(error));
        });
      }
    } catch (error) {
      this.sendError(message.id, createDispatchError(error));
    }
  }

  subscribe(): void {
    this.subscribedValue = true;
  }

  unsubscribe(): void {
    this.subscribedValue = false;
  }

  close(): void {
    if (this.closed) {
      return;
    }

    if (this.canCloseSocket()) {
      this.socket.close();
    }
    this.handleClose();
  }

  handleClose = (): void => {
    if (this.closedValue) {
      return;
    }

    this.closedValue = true;
    this.socket.off("message", this.handleSocketMessage);
    this.socket.off("close", this.handleClose);
    this.onClose(this.controlId);
  };

  private handleSocketMessage = (data: RawData): void => {
    if (this.closed) {
      return;
    }

    const messageText = rawDataToString(data);
    const value = parseJsonValue(messageText);

    if (!isControlRpcRequest(value)) {
      this.sendInvalidMessageError(value);
      return;
    }

    this.handleMessage(value);
  };

  private sendInvalidMessageError(value: unknown): void {
    const rpcId =
      isRecord(value) && isNumber(value.id)
        ? value.id
        : INVALID_MESSAGE_RPC_ID;

    this.sendError(rpcId, {
      code: "invalid-control-message",
      message: "Invalid multiplexer control message",
    });
  }

  private canSend(): boolean {
    if (this.closed) {
      return false;
    }

    const readyState = this.socket.readyState;
    return readyState === WebSocket.OPEN;
  }

  private canCloseSocket(): boolean {
    const readyState = this.socket.readyState;
    return (
      readyState === WebSocket.OPEN ||
      readyState === WebSocket.CONNECTING
    );
  }
}

function createDispatchError(error: unknown): ControlRpcError {
  return {
    code: "control-message-dispatch-failed",
    message:
      error instanceof Error
        ? error.message
        : "Failed to dispatch multiplexer control message",
  };
}

function rawDataToString(data: RawData): string {
  if (typeof data === "string") {
    return data;
  }

  if (Array.isArray(data)) {
    return Buffer.concat(data).toString();
  }

  if (data instanceof ArrayBuffer) {
    return Buffer.from(data).toString();
  }

  return data.toString();
}
