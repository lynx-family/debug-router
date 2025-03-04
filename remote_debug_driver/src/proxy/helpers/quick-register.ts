// Copyright 2025 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

import type { IAbstractSocketConnection } from "../socket.model";

import { SocketEvents } from "../message.model";
import { sendEvent } from "./send-event";
import { waitEvent } from "./wait-event";

/**
 * Helper that register device to server automatically
 * @param socket Target socket connection
 */
export async function quickRegister(
  socket: IAbstractSocketConnection,
  extraDescriptors?: Record<string, any>
): Promise<number> {
  const identifier = (await waitEvent(socket, SocketEvents.Initialize)).data;
  sendEvent(socket, {
    event: SocketEvents.Register,
    data: { id: identifier, ...extraDescriptors },
  });
  await waitEvent(socket, SocketEvents.Registered);
  return identifier;
}
