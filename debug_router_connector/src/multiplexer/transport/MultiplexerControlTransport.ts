// Copyright 2026 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

import type { Socket } from "net";
// @ts-ignore
import * as bufferpack from "bufferpack";
import { defaultLogger } from "../../utils/logger";

const FRAME_PREFIX = "$MUX";
const FRAME_HEADER_FORMAT = "! 4s I";
const FRAME_HEADER_SIZE = 8;
export const DEFAULT_MULTIPLEXER_CONTROL_MAX_FRAME_SIZE = 16 * 1024 * 1024;
export const DEFAULT_MULTIPLEXER_CONTROL_MAX_BUFFER_SIZE = 32 * 1024 * 1024;

export type MultiplexerControlTransportOption = {
  maxFrameSize?: number;
  maxBufferSize?: number;
};

export class MultiplexerControlTransportError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "MultiplexerControlTransportError";
    this.code = code;
  }
}

export class MultiplexerControlTransport {
  private readonly socket: Socket;
  private readonly maxFrameSize: number;
  private readonly maxBufferSize: number;
  private connectListener: (() => void) | undefined;
  private messageListener: ((message: unknown) => void) | undefined;
  private readonly closeListeners = new Set<(error?: Error) => void>();
  private buffer = Buffer.alloc(0);
  private closeError: Error | undefined;

  constructor(socket: Socket, option: MultiplexerControlTransportOption = {}) {
    this.socket = socket;
    this.maxFrameSize =
      option.maxFrameSize ?? DEFAULT_MULTIPLEXER_CONTROL_MAX_FRAME_SIZE;
    this.maxBufferSize =
      option.maxBufferSize ?? DEFAULT_MULTIPLEXER_CONTROL_MAX_BUFFER_SIZE;

    socket.on("connect", this.handleSocketConnect);
    socket.on("data", this.handleData);
    socket.on("end", this.handleEnd);
    socket.on("close", this.handleSocketClose);
    socket.on("error", this.handleSocketError);
  }

  get closed(): boolean {
    return this.socket.destroyed;
  }

  get writable(): boolean {
    return !this.closed && this.socket.writable;
  }

  send(message: unknown): void {
    if (!this.writable) {
      throw new Error("Multiplexer control transport is not writable");
    }

    const serialized = JSON.stringify(message);
    if (serialized === undefined) {
      throw new Error("Multiplexer control message is not JSON serializable");
    }

    const payload = Buffer.from(serialized, "utf8");
    if (payload.length > this.maxFrameSize) {
      throw new MultiplexerControlTransportError(
        "frame-too-large",
        `Multiplexer control frame exceeds ${this.maxFrameSize} bytes`,
      );
    }

    const frame = bufferpack.pack(`${FRAME_HEADER_FORMAT} ${payload.length}A`, [
      FRAME_PREFIX,
      payload.length,
      payload,
    ]);
    this.socket.write(frame);
  }

  onConnect(listener: () => void): () => void {
    this.connectListener = listener;
    return () => {
      this.connectListener = undefined;
    };
  }

  onMessage(listener: (message: unknown) => void): () => void {
    this.messageListener = listener;
    return () => {
      this.messageListener = undefined;
    };
  }

  onClose(listener: (error?: Error) => void): () => void {
    if (this.closed) {
      listener(this.closeError);
      return () => {};
    }

    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  end(): Promise<void> {
    if (this.closed) {
      return Promise.resolve();
    }

    return new Promise((resolve) => {
      this.onClose(() => resolve());
      this.socket.end();
    });
  }

  destroy(error?: Error): void {
    if (this.closed) {
      return;
    }

    this.closeError = error ?? this.closeError;
    this.socket.destroy();
  }

  private readonly handleData = (chunk: Buffer): void => {
    if (this.closed || chunk.length === 0) {
      return;
    }

    if (this.buffer.length + chunk.length > this.maxBufferSize) {
      this.destroy(
        new MultiplexerControlTransportError(
          "buffer-too-large",
          `Multiplexer control buffer exceeds ${this.maxBufferSize} bytes`,
        ),
      );
      return;
    }

    this.buffer =
      this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    this.parseFrames();
  };

  private parseFrames(): void {
    while (!this.closed && this.buffer.length >= FRAME_HEADER_SIZE) {
      const frameStart = this.buffer.indexOf(FRAME_PREFIX);
      if (frameStart < 0) {
        const discardedLength = this.buffer.length - FRAME_PREFIX.length;
        this.buffer = this.buffer.subarray(discardedLength);
        return;
      }
      this.buffer = this.buffer.subarray(frameStart);

      if (this.buffer.length < FRAME_HEADER_SIZE) {
        return;
      }

      const [, payloadLength] = bufferpack.unpack(
        FRAME_HEADER_FORMAT,
        this.buffer,
        0,
      );
      if (payloadLength === 0) {
        const error = new MultiplexerControlTransportError(
          "invalid-frame",
          "Multiplexer control frame payload length must be greater than zero",
        );
        defaultLogger.warn(error.message);
        this.destroy(error);
        return;
      }
      if (payloadLength > this.maxFrameSize) {
        const error = new MultiplexerControlTransportError(
          "frame-too-large",
          `Multiplexer control frame exceeds ${this.maxFrameSize} bytes`,
        );
        defaultLogger.warn(error.message);
        this.destroy(error);
        return;
      }

      const frameLength = FRAME_HEADER_SIZE + payloadLength;
      if (this.buffer.length < frameLength) {
        return;
      }

      const payload = this.buffer.subarray(FRAME_HEADER_SIZE, frameLength);

      let message: unknown;
      try {
        message = JSON.parse(payload.toString("utf8"));
      } catch (error) {
        const frameError = new MultiplexerControlTransportError(
          "invalid-frame",
          `Failed to parse multiplexer control message: ${String(error)}`,
        );
        defaultLogger.warn(frameError.message);
        this.destroy(frameError);
        return;
      }

      this.buffer = this.buffer.subarray(frameLength);
      this.messageListener?.(message);
    }
  }

  private readonly handleSocketConnect = (): void => {
    this.connectListener?.();
  };

  private readonly handleEnd = (): void => {
    if (this.buffer.length > 0 && !this.closeError) {
      this.closeError = new MultiplexerControlTransportError(
        "incomplete-frame",
        "Multiplexer control socket ended with an incomplete frame",
      );
    }
    this.socket.destroy();
  };

  private readonly handleSocketClose = (): void => {
    this.notifyClose();
  };

  private readonly handleSocketError = (error: Error): void => {
    this.closeError = error;
    this.socket.destroy();
  };

  private notifyClose(): void {
    this.socket.off("connect", this.handleSocketConnect);
    this.socket.off("data", this.handleData);
    this.socket.off("end", this.handleEnd);
    this.socket.off("close", this.handleSocketClose);
    this.socket.off("error", this.handleSocketError);
    this.buffer = Buffer.alloc(0);
    this.connectListener = undefined;

    for (const listener of Array.from(this.closeListeners)) {
      listener(this.closeError);
    }
    this.closeListeners.clear();
    this.messageListener = undefined;
  }
}
