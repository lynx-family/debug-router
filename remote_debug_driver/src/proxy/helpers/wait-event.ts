// Copyright 2025 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

import type { ITypedSocketMessage, SocketEvents } from "../message.model";
import type { IAbstractSocketConnection } from "../socket.model";

import { decodeSocketMessage } from "../message";

/**
 * Wait until received given event
 * @param socket Socket connection
 * @param event Target event
 */
export function waitEvent<T extends SocketEvents>(
  socket: IAbstractSocketConnection,
  event: T
): Promise<ITypedSocketMessage<T>> {
  return new Promise((resolve, reject) => {
    const messageListener = (data: string): void => {
      const message = decodeSocketMessage(data, event);
      if (message != null) {
        socket.off("message", messageListener);
        socket.off("close", closeListener);
        resolve(message);
      }
    };
    const closeListener = (event?: { code?: number; reason?: string }): void =>
      reject({ code: event?.code, reason: event?.reason });
    socket.on("message", messageListener);
    socket.on("close", closeListener);
  });
}
