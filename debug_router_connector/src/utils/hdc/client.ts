/*
 *
 * Copyright © 2013 CyberAgent, Inc.
 * Copyright © 2016 The OpenSTF Project
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *    http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 *
 * This file may have been modified by ByteDance Ltd. and/cor its affiliates.
 */
import { EventEmitter } from "events";
import { ClientOptions } from "./ClientOptions";
import Connection from "./connection";
import TargetsCommand from "./command/host/targets";
import Target from "./Target";
import TargetClient from "./TargetClient";
import Tracker from "./tracker";
import { defaultLogger } from "../../utils/logger";
import { getDriverReportService } from "../../report/interface/DriverReportService";

export default class Client extends EventEmitter {
  public readonly options: ClientOptions;
  public readonly host: string;
  public readonly port: number;
  public readonly bin: string;
  public readonly timemout: number;

  constructor(
    {
      host = "127.0.0.1",
      port = 8710,
      bin = "hdc",
      timeout = 0,
    }: ClientOptions = { port: 8710 },
  ) {
    super();
    this.host = host;
    this.port = port;
    this.bin = bin;
    this.timemout = timeout;

    this.options = { host, port, bin, timeout };
  }

  public connection(connectKey: string = ""): Promise<Connection> {
    const connection = new Connection(this.options);
    connection.on("error", (err) => this.emit("error", err));
    return connection.connect(connectKey);
  }

  public connect(host: string, port: number): Promise<boolean> {
    if (host.indexOf(":") !== -1) {
      const [h, portString] = host.split(":", 2);
      host = h;
      const parsed = parseInt(portString, 10);
      if (!isNaN(parsed)) {
        port = parsed;
      }
    }

    return this.connection()
      .then((conn) => {
        return true;
      })
      .catch((e: Error) => {
        defaultLogger.debug(`Connect ${host}:${port} fail: ${e.message}`);
        getDriverReportService()?.report("hdc_client_connect_error", null, {
          msg: `connect ${host}:${port} failed`,
          error: e.message,
        });
        return false;
      });
  }

  public async kill(): Promise<void> {
    return this.connection()
      .then((conn) => conn.kill())
      .catch((e: Error) => {
        defaultLogger.debug(`Kill fail: ${e.message}`);
        getDriverReportService()?.report("hdc_client_kill_error", null, {
          msg: `hdc client kill connection failed`,
          error: e.message,
        });
      });
  }

  public async listTargets(): Promise<Target[]> {
    return this.connection()
      .then((conn) => new TargetsCommand(conn).execute())
      .catch((e: Error) => {
        defaultLogger.debug(`ListTargets fail: ${e.message}`);
        getDriverReportService()?.report(
          "hdc_client_list_targets_error",
          null,
          {
            msg: `hdc client list targets failed`,
            error: e.message,
          },
        );
        return [];
      });
  }

  public getDevice(serial: string): TargetClient {
    return new TargetClient(this, serial);
  }

  public async trackTargets(): Promise<Tracker> {
    return new Tracker(this);
  }
}
