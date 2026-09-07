// Copyright 2026 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

import {
  ControlRpcError,
  ControlRpcRequest,
  ControlRpcResponse,
} from "../protocol/control";
import type { MultiplexerDebugInfo } from "../protocol/debuginfo";
import { ControlEvent } from "../protocol/event";
import {
  isControlRpcRequest,
  isNumber,
  isRecord,
} from "../protocol/validation";
import { MultiplexerControlTransport } from "../transport/MultiplexerControlTransport";

const INVALID_MESSAGE_RPC_ID = -1;

export type MultiplexerControlConnectionOption = {
  controlId: number;
  transport: MultiplexerControlTransport;
  onMessage: (controlId: number, message: ControlRpcRequest) => Promise<void>;
  onClose: (controlId: number) => void;
  createDebugInfo?: () => MultiplexerDebugInfo | undefined;
};

export class MultiplexerControlConnection {
  readonly controlId: number;
  readonly transport: MultiplexerControlTransport;
  private readonly onMessage: (
    controlId: number,
    message: ControlRpcRequest,
  ) => Promise<void>;
  private readonly onClose: (controlId: number) => void;
  private readonly createDebugInfo?: () => MultiplexerDebugInfo | undefined;
  private closed = false;
  private unsubscribeMessage: (() => void) | undefined;
  private unsubscribeClose: (() => void) | undefined;

  constructor(option: MultiplexerControlConnectionOption) {
    this.controlId = option.controlId;
    this.transport = option.transport;
    this.onMessage = option.onMessage;
    this.onClose = option.onClose;
    this.createDebugInfo = option.createDebugInfo;
    this.unsubscribeMessage = this.transport.onMessage(
      this.handleTransportMessage,
    );
    this.unsubscribeClose = this.transport.onClose(this.handleClose);
  }

  send(message: ControlEvent | ControlRpcResponse): void {
    if (this.closed || !this.transport.writable) {
      return;
    }

    const debugInfo = this.createDebugInfo?.();
    try {
      this.transport.send(debugInfo ? { ...message, debugInfo } : message);
    } catch (error) {
      this.transport.destroy(
        error instanceof Error ? error : new Error(String(error)),
      );
    }
  }

  sendResponse(rpcId: number, result: unknown): void {
    this.send({
      kind: "rpc-response",
      id: rpcId,
      ok: true,
      result: result === undefined ? {} : result,
    } as ControlRpcResponse);
  }

  sendError(rpcId: number, error: ControlRpcError): void {
    this.send({ kind: "rpc-response", id: rpcId, ok: false, error });
  }

  close(): Promise<void> {
    if (!this.closed) {
      this.handleClose();
    }
    return this.transport.end();
  }

  handleClose = (): void => {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.unsubscribeMessage?.();
    this.unsubscribeClose?.();
    this.unsubscribeMessage = undefined;
    this.unsubscribeClose = undefined;
    this.onClose(this.controlId);
  };

  private readonly handleTransportMessage = (value: unknown): void => {
    if (this.closed) {
      return;
    }
    if (!isControlRpcRequest(value)) {
      const rpcId =
        isRecord(value) && isNumber(value.id)
          ? value.id
          : INVALID_MESSAGE_RPC_ID;
      this.sendError(rpcId, {
        code: "invalid-control-message",
        message: "Invalid multiplexer control message",
      });
      return;
    }
    void this.onMessage(this.controlId, value);
  };
}
