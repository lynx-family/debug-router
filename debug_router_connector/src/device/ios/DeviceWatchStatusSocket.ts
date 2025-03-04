// Copyright 2024 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

import { Socket } from "net";
import { WatchStatus } from "../WatchStatus";

export class DeviceWatchStatusSocket {
  public currentWatchStatus: WatchStatus = WatchStatus.StopWatching;
  private rawSocket: Socket;
  constructor(socket: Socket) {
    this.rawSocket = socket;
  }
  public getRawSocket(): Socket {
    return this.rawSocket;
  }
}
