// Copyright 2024 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

import { UsbClient } from "./Client";
import { BaseDevice } from "../device/BaseDevice";
import { ClientDescription, ClientQuery } from "../utils/type";
import ClientAdapter, { ClientEventsListener } from "./ClientAdapter";
import { Connection } from "./Connection";
import { USBConnection } from "./USBConnection";
import { DebugRouterConnector } from "../connector";
import { defaultLogger } from "../utils/logger";

export class ClientController implements ClientEventsListener {
  private timer: NodeJS.Timeout | undefined;
  private closed: boolean = false;
  private sockets: Map<number, ClientAdapter> = new Map();
  private ports: Map<number, boolean> = new Map();
  private clientInfos: Map<number, number> = new Map();
  private readonly portSnapshot: Set<number>;
  connections: Map<number, UsbClient> = new Map();
  driver: DebugRouterConnector;
  device: BaseDevice;

  constructor(driver: DebugRouterConnector, serverDevice: BaseDevice) {
    this.driver = driver;
    this.device = serverDevice;
    this.portSnapshot = new Set(this.device.ports);

    this.portSnapshot.forEach((port) => {
      this.sockets.set(port, this.createAdapter(port));
      this.ports.set(port, false);
    });
  }

  matchesPorts(ports: number[]): boolean {
    const currentPorts = new Set(ports);
    return (
      currentPorts.size === this.portSnapshot.size &&
      [...currentPorts].every((port) => this.portSnapshot.has(port))
    );
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
    if (this.closed) {
      connection.close();
      return 0;
    }
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
    if (connection instanceof USBConnection) {
      connection.setTraceClientId(id);
    }

    this.connections.set(id, client);
    // port has connected
    this.ports.set(port, true);
    this.clientInfos.set(id, port);
    this.driver.traceRecorder?.recordUsbClientConnected(client);
    this.driver.regiserUsbClient(client);
    return id;
  }

  private removeConnection(id: number) {
    const client = this.connections.get(id);
    if (!client) {
      return;
    }

    this.driver.traceRecorder?.recordUsbClientDisconnected(client);
    this.connections.delete(id);
    const port = this.clientInfos.get(id);
    if (port !== undefined) {
      this.ports.set(port, false);
      this.clientInfos.delete(id);
    }
    this.driver.unregiserUsbClient(id);
  }

  private createAdapter(port: number): ClientAdapter {
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
    if (this.closed) {
      return;
    }
    for (const port of this.ports.keys()) {
      if (!this.ports.get(port)) {
        let connectAdapter = this.sockets.get(port);
        if (connectAdapter?.isAttemptActive()) {
          continue;
        }
        if (!connectAdapter || connectAdapter.isClosed()) {
          connectAdapter?.destroy();
          connectAdapter = this.createAdapter(port);
          this.sockets.set(port, connectAdapter);
        }
        defaultLogger.debug("watchClient:connect:" + port);
        connectAdapter.connect();
      }
    }
  }

  startWatchClient(): void {
    if (this.closed) {
      return;
    }
    this.watchClient();
    if (process.env.DriverAutoFindClientsEnv === "false") {
      defaultLogger.warn("AutoFinding new client is closed for debug");
      return;
    }
    if (!this.timer) {
      this.timer = setInterval(() => {
        this.watchClient();
      }, this.driver.usbConnectOpt.retryTime);
    }
  }

  stopWatchClient(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  private closeAllConnection(): void {
    defaultLogger.debug("closeAllConnection");
    this.connections.forEach((connectionInfo, id) => {
      this.removeConnection(id);
    });
  }

  close() {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.stopWatchClient();
    this.closeAllConnection();
    this.sockets.forEach((adapter) => adapter.destroy());
    this.sockets.clear();
    this.clientInfos.clear();
    this.ports.clear();
  }
}
