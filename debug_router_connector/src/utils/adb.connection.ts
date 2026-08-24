// Copyright 2024 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

import { Socket } from "net";
import AdbConnection from "@devicefarmer/adbkit/dist/src/adb/connection";

export async function disposeAdbConnection(
  connection: AdbConnection,
): Promise<void> {
  const socket = connection.getSocket() as Socket | undefined;
  if (!socket || socket.destroyed) {
    return;
  }

  await new Promise<void>((resolve) => {
    socket.once("close", resolve);
    socket.destroy();
  });
}

export async function withAdbConnection<T>(
  connect: () => PromiseLike<AdbConnection>,
  execute: (connection: AdbConnection) => T | PromiseLike<T>,
): Promise<T> {
  const connection = await connect();
  try {
    return await execute(connection);
  } finally {
    await disposeAdbConnection(connection);
  }
}
