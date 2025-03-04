// Copyright 2024 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

import * as net from "net";
import { RequireMessageType, ResponseMessageType } from "../utils/type";
import { Connection } from "./Connection";
import { packMessage } from "./utils";
import { defaultLogger } from "../utils/logger";

export class USBConnection extends Connection {
  constructor(protected socket: net.Socket) {
    super();
  }

  close(): void {
    defaultLogger.debug("USBConnection: close");
    this.socket.end();
  }

  send(data: any): void {
    if (this.socket.writable) {
      if (process.env.PrintAllUSBMessage === "enable") {
        defaultLogger.info("[Send]:" + JSON.stringify(data));
      }
      this.socket.write(packMessage(data));
    }
  }
  sendExpectResponse(
    require: RequireMessageType,
  ): Promise<ResponseMessageType> {
    return new Promise((resolve, reject) => {
      if (require.event === "Initialize") {
        this.pendingRequests.set(require.event, { reject, resolve });
      } else if (require.event === "Customized") {
        const data = require.data;
        if (data.type === "CDP" || data.type === "App") {
          this.pendingRequests.set(data.data.message.id.toString(), {
            reject,
            resolve,
          });
        } else {
          this.pendingRequests.set(data.type, { reject, resolve });
        }
      }
      this.send(require);
    });
  }
}
