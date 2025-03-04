// Copyright 2025 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

import type {
  ITypedSocketMessage,
  SocketEvents,
  SocketEventMap,
  ISocketMessage,
} from "../message.model";
import type { IAbstractSocketConnection } from "../socket.model";

import { encodeSocketMessage } from "../message";

/**
 * Send event and data through socket connection
 * @param socket Socket connection
 * @param message Message content
 */
export function sendEvent<T extends SocketEvents>(
  socket: IAbstractSocketConnection,
  message: ITypedSocketMessage<T>
): void;
export function sendEvent<T = void>(
  socket: IAbstractSocketConnection,
  message: ISocketMessage<T> & { event: Exclude<number, keyof SocketEventMap> }
): void;
export function sendEvent<T extends SocketEvents>(
  socket: IAbstractSocketConnection,
  message: ISocketMessage<T>
): void {
  socket.send(encodeSocketMessage(message));
}
