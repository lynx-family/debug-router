// Copyright 2025 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

import type { IAbstractSocketConnection } from "../socket.model";
import type { ISocketMessage } from "../message.model";

import {
  decodeSocketMessage,
  encodeSocketMessage,
  isUnknownMessage,
} from "../message";
import { SocketEvents, SocketExceptions } from "../message.model";

export function createMessageHandler(
  handler: (data: ISocketMessage<any>) => void,
  connection?: IAbstractSocketConnection,
  handleUnknownMessage?: boolean
): (data: string | ISocketMessage<any>) => void {
  return (data) => {
    const message =
      typeof data === "string"
        ? decodeSocketMessage(data)
        : data instanceof Buffer
        ? decodeSocketMessage(data.toString())
        : data;
    if (handleUnknownMessage && isUnknownMessage(message)) {
      connection?.send(
        encodeSocketMessage({
          event: SocketEvents.Exception,
          data: SocketExceptions.UnknownCommand,
        })
      );
      return;
    }
    message && handler(message);
  };
}
