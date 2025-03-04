// Copyright 2024 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

import { UsbClient } from "./Client";
import { BaseDevice } from "../device/BaseDevice";
import { ClientDescription, ClientQuery } from "../utils/type";
import ClientAdapter, { ClientEventsListener } from "./ClientAdapter";
import { Connection } from "./Connection";
import { DebugRouterConnector } from "../connector";
import { defaultLogger } from "../utils/logger";

export class ClientController implements ClientEventsListener {
  private timer: NodeJS.Timeout | undefined;
  private sockets: Map<number, ClientAdapter> = new Map();
  private ports: Map<number, boolean> = new Map();
  private clientInfos: Map<number, number> = new Map();
  connections: Map<number, UsbClient> = new Map();
  driver: DebugRouterConnector;
  device: BaseDevice;

  constructor(driver: DebugRouterConnector, serverDevice: BaseDevice) {
    this.driver = driver;
    this.device = serverDevice;

    this.device.ports.map((port) => {
      const connectAdapter = new ClientAdapter(
        this.driver,
        this,
        port,
        this.device.info.title,
        this.device.info.serial,
        this.device.info.os,
        this.device.getHost(),
      );
      this.sockets.set(port, connectAdapter);
      this.ports.set(port, false);
    });
  }

  onConnectionDeleted(id: number): void {
    this.removeConnection(id);
  }

  onConnectionCreated(
    connection: Connection,
    port: number,
    ClientQuery: ClientQuery,
  ): number {
    return this.addConnection(connection, port, ClientQuery);
  }

  addConnection(
    connection: Connection,
    port: number,
    query: ClientQuery,
  ): number {
    defaultLogger.debug(
      "addConnection port: " + port + " info: " + JSON.stringify(query),
    );
    const id = this.driver.createClientId();
    const info: ClientDescription = {
      port,
      id,
      query,
    };

    if (this.connections.has(id)) {
      return id;
    }

    const client = new UsbClient(info, connection);

    this.connections.set(id, client);
    // port has connected
    this.ports.set(port, true);
    this.clientInfos.set(id, port);
    this.driver.regiserUsbClient(client);
    return id;
  }

  private removeConnection(id: number) {
    const client = this.connections.get(id);
    if (client) {
      this.connections.delete(id);
    }
    const port = this.clientInfos.get(id);
    if (port) {
      this.ports.set(port, false);
      this.clientInfos.delete(id);
    }
    this.driver.unregiserUsbClient(id);
  }

  private createAdapter(
    connectAdapter: ClientAdapter | undefined,
    port: number,
  ): ClientAdapter {
    return new ClientAdapter(
      this.driver,
      this,
      port,
      this.device.info.title,
      this.device.info.serial,
      this.device.info.os,
      this.device.getHost(),
    );
  }

  private watchClient() {
    for (const port of this.ports.keys()) {
      if (!this.ports.get(port)) {
        const connectAdapter = this.sockets.get(port);
        const newAdapter = this.createAdapter(connectAdapter, port);
        connectAdapter?.destroy();
        if (newAdapter === null) {
          defaultLogger.debug("newAdapter === null:" + port);
          return;
        }
        this.sockets.set(port, newAdapter);
        defaultLogger.debug("watchClient:connect:" + port);
        newAdapter.connect();
      }
    }
  }

  startWatchClient(): void {
    this.watchClient();
    if (process.env.DriverAutoFindClientsEnv === "false") {
      defaultLogger.warn("AutoFinding new client is closed for debug");
      return;
    }
    this.timer = setInterval(() => {
      this.watchClient();
    }, this.driver.usbConnectOpt.retryTime);
  }

  stopWatchClient(): void {
    if (this.timer) {
      clearInterval(this.timer);
    }
  }

  private closeAllConnection(): void {
    defaultLogger.debug("closeAllConnection");
    this.connections.forEach((connectionInfo, id) => {
      this.removeConnection(id);
    });
  }

  close() {
    this.stopWatchClient();
    this.closeAllConnection();
  }
}
