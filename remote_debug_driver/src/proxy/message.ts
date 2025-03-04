// Copyright 2025 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

import type {
  ISocketMessage,
  SocketEventMap,
  ITypedSocketMessage,
} from "./message.model";
import type { SocketData } from "./socket.model";

import { SocketEvents } from "./message.model";

/**
 * Available event names
 * @ignore
 */
const availableEvents: SocketEvents[] = Object.values(SocketEvents);

/**
 * Encode socket message structure to string
 * @param message Target message
 */
export function encodeSocketMessage<T extends SocketEvents>(
  message: ITypedSocketMessage<T>
): string;
export function encodeSocketMessage<T = void>(
  message: ISocketMessage<T> & { event: Exclude<number, keyof SocketEventMap> }
): string;
export function encodeSocketMessage<T = void>(
  message: ISocketMessage<T>
): string {
  return JSON.stringify(message);
}

/**
 * Try decode socket message structure from string
 * @param data Target string
 */
export function decodeSocketMessage(
  data: string | SocketData
): ISocketMessage<unknown> | undefined;
/**
 * Try decode socket message structure from string. If decoded message doesn't match given type, function will return undefined.
 * @param data Target string
 * @param event Event type of message
 */
export function decodeSocketMessage<T extends SocketEvents>(
  data: string | SocketData,
  event: T
): ITypedSocketMessage<T> | undefined;
export function decodeSocketMessage<T extends SocketEvents>(
  data: string | SocketData,
  event?: T
): ISocketMessage<unknown> | undefined {
  try {
    const message = JSON.parse(
      typeof data === "string" ? data : data.toString()
    ) as ISocketMessage<any>;
    if (!("event" in message)) return undefined;
    if (!("data" in message)) (message as Record<string, any>).data = undefined;
    if (event == null) return message;
    return isTypedSocketMessage(message, event) ? message : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Check if message has given type
 * @param message Target message
 * @param event Event type
 */
export function isTypedSocketMessage<T extends SocketEvents>(
  message: ISocketMessage<any> | undefined,
  event: T
): message is ITypedSocketMessage<T> {
  return message?.event === event;
}

/**
 * Check if message is not recognizable
 * @param message Target message
 */
export function isUnknownMessage(
  message: ISocketMessage<any> | undefined
): message is undefined {
  return message == null || !availableEvents.includes(message.event);
}
