// Copyright 2026 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

import { EventEmitter } from "events";
import { UsbClient } from "../usb/Client";
import { AndroidDeviceManager } from "../device/android/AndroidDeviceManager";
import { BaseDevice } from "../device/BaseDevice";
import AndroidDevice from "../device/android/AndroidDevice";
import { DeviceManager } from "../device/DeviceManager";
import NetworkDeviceManager from "../device/network/NetworkDeviceManager";
import DesktopDeviceManager from "../device/desktop/DesktopDeviceManager";
import iOSDeviceManager from "../device/ios/iOSDeviceManager";
import HarmonyDeviceManager from "../device/Harmony/HarmonyDeviceManager";
import { defaultLogger } from "../utils/logger";
import { getDriverReportService } from "../report/interface/DriverReportService";
import { PhysicalConnectorEvent } from "../utils/type";
import {
  monitorUnregisterClient,
  monitorUnregisterDevice,
  setClientTimeMap,
  setDeviceTimeMap,
} from "./MonitorUtils";
import type { ConnectionTraceRecorder } from "../trace/ConnectionTraceRecorder";

export type PhysicalConnectorOption = {
  manualConnect?: boolean;
  enableAndroid?: boolean;
  enableIOS?: boolean;
  enableHarmony?: boolean;
  enableDesktop?: boolean;
  enableNetworkDevice?: boolean;
  adbHostPort?: {
    host?: string;
    port?: number;
  };
  hdcHostPort?: {
    host?: string;
    port?: number;
  };
  usbConnectOpt?: {
    retryTime: number;
  };
  networkDeviceOpt?: {
    ip: string;
    // a network device can have multi debugger clients
    port: number[];
  };
  traceRecorder?: ConnectionTraceRecorder | null;
};

export class PhysicalConnector {
  private readonly events = new EventEmitter();
  readonly devices = new Map<string, BaseDevice>();
  readonly usbClients = new Map<number, UsbClient>();
  private nextClientId: number = 0;
  private enableAndroid: boolean;
  private enableIOS: boolean;
  private enableHarmony: boolean;
  private enableDesktop: boolean;
  private readonly enableNetworkDevice: boolean;
  public readonly traceRecorder: ConnectionTraceRecorder | null = null;
  private readonly networkDeviceOpt:
    | {
        ip: string;
        port: number[];
      }
    | undefined;
  readonly adbOption: any;
  readonly hdcOption: any;
  readonly usbConnectOpt: {
    retryTime: number;
  };
  private closed: boolean = false;
  private devicesManager: Set<DeviceManager>;

  constructor(
    option: PhysicalConnectorOption = {
      manualConnect: false,
      enableAndroid: true,
      enableIOS: true,
      enableHarmony: true,
      enableDesktop: false,
      enableNetworkDevice: false,
      traceRecorder: null,
    },
  ) {
    getDriverReportService()?.init(option.manualConnect);
    const msg = "PhysicalConnectorOption:" + JSON.stringify(option);
    defaultLogger.debug(msg);
    getDriverReportService()?.report(
      "PhysicalConnectorInit",
      {},
      { option: msg },
    );
    if (!option.manualConnect) {
      getDriverReportService()?.report(
        "PhysicalConnectorInitOfNoManualConnect",
        {},
        { option: msg },
      );
    }
    this.enableAndroid = option.enableAndroid ?? true;
    this.adbOption = option.adbHostPort;
    // add win32 support
    this.enableIOS =
      process.platform === "darwin" || process.platform === "win32"
        ? option.enableIOS ?? true
        : false;
    this.enableHarmony = option.enableHarmony ?? true;
    this.hdcOption = option.hdcHostPort;
    this.enableDesktop = option.enableDesktop ?? false;
    this.enableNetworkDevice = option.enableNetworkDevice ?? false;
    if (this.enableNetworkDevice) {
      this.networkDeviceOpt = option.networkDeviceOpt;
    }
    this.usbConnectOpt = option.usbConnectOpt ?? {
      retryTime: 3000,
    };
    if (this.usbConnectOpt.retryTime < 3000) {
      this.usbConnectOpt.retryTime = 3000;
    }
    this.traceRecorder = option.traceRecorder ?? null;
    this.devicesManager = new Set<DeviceManager>();
    if (this.enableAndroid) {
      this.devicesManager.add(new AndroidDeviceManager(this, this.adbOption));
    }
    if (this.enableIOS) {
      this.devicesManager.add(new iOSDeviceManager(this));
    }
    if (this.enableHarmony) {
      this.devicesManager.add(new HarmonyDeviceManager(this, this.hdcOption));
    }
    if (this.enableDesktop) {
      this.devicesManager.add(new DesktopDeviceManager(this));
    }
    if (this.enableNetworkDevice) {
      if (this.networkDeviceOpt) {
        // NetWorkDevices use ip as their serial.
        this.devicesManager.add(
          new NetworkDeviceManager(this, this.networkDeviceOpt),
        );
      } else {
        getDriverReportService()?.report("network_connect_error", null, {
          msg: "networkDeviceOpt == undefined",
          stage: "device",
        });
        defaultLogger.error("networkDeviceOpt == undefined");
      }
    }
  }

  // functions Migrated from DebugRouterConnector， not modified

  disableAllClients() {
    defaultLogger.info("disableAllClients");
    // close usb autoConnect
    this.devices.forEach((device) => {
      device.stopWatchClient();
    });
    this.getAllUsbClients().forEach((client) => {
      client.close();
    });
  }

  async connectDevices(
    timeout: number = -1,
    serial: string | null = null,
  ): Promise<BaseDevice[]> {
    await this.startDeviceListeners();
    return this.getDevices(timeout, serial);
  }

  private async startDeviceListeners() {
    const asyncDeviceListenersPromises: Array<Promise<void>> = [];
    for (const deviceManager of this.devicesManager) {
      asyncDeviceListenersPromises.push(
        deviceManager.watchDevices().catch((e) => {
          getDriverReportService()?.report("device_connect_error", null, {
            msg: "watchDevices error:" + e?.message,
            stage: "device",
          });
          throw e;
        }),
      );
    }
    await Promise.all(asyncDeviceListenersPromises);
  }

  on<Event extends keyof PhysicalConnectorEvent>(
    event: Event,
    callback: (payload: PhysicalConnectorEvent[Event]) => void,
  ): void {
    this.events.on(event, callback);
  }

  off<Event extends keyof PhysicalConnectorEvent>(
    event: Event,
    callback: (payload: PhysicalConnectorEvent[Event]) => void,
  ): void {
    this.events.off(event, callback);
  }

  unregisterDevice(serial: string) {
    const device = this.devices.get(serial);
    if (!device) {
      defaultLogger.debug(
        "unregisterDevice warning: no existed device:" + serial,
      );
      return;
    }
    defaultLogger.debug("unregisterDevice:" + serial);
    this.traceRecorder?.recordDeviceUnregistered(serial, {
      os: device.info.os,
      title: device.info.title,
    });
    this.devices.delete(serial);
    device.disConnect(); // we'll only destroy upon replacement
    this.emit("device-disconnected", device);
    monitorUnregisterDevice(device, this.usbConnectOpt.retryTime);
  }

  getDevices(
    timeout: number = -1,
    serial: string | null = null,
  ): Promise<BaseDevice[]> {
    return new Promise((resolve) => {
      if (timeout < 0) {
        resolve(this.findDevice(serial));
      } else {
        const deviceCallback = (device: BaseDevice) => {
          if (device.serial === serial) {
            resolve([device]);
            this.off("device-connected", deviceCallback);
          }
        };
        if (serial !== null) {
          const targetDevices = this.findDevice(serial);
          if (targetDevices.length > 0) {
            resolve(targetDevices);
            return;
          }
          this.on("device-connected", deviceCallback);
        }
        setTimeout(() => {
          this.off("device-connected", deviceCallback);
          resolve(this.findDevice(serial));
        }, timeout);
      }
    });
  }

  private findDevice(serial: string | null): BaseDevice[] {
    let targetDevices = Array.from(this.devices.values());
    if (serial === null) {
      return targetDevices;
    }
    targetDevices = targetDevices.filter((device) => {
      return device.serial === serial;
    });
    return targetDevices;
  }

  getAllUsbClients(): UsbClient[] {
    const clients = new Array();
    this.usbClients.forEach((value, key) => {
      clients.push(value);
    });
    return clients;
  }

  getDeviceUsbClients(
    deviceId: string,
    timeout: number = -1,
    clientName: string | null = null,
  ): Promise<UsbClient[]> {
    return new Promise((resolve) => {
      if (!this.devices.has(deviceId)) {
        defaultLogger.debug("getDeviceUsbClients: has" + deviceId);
        resolve([]);
      }
      if (timeout < 0) {
        let clients = Array.from(this.usbClients.values());
        clients = clients.filter((client) => {
          return client.deviceId() === deviceId;
        });
        resolve(this.findUsbClient(clientName, clients));
      } else {
        const clientCallback = (client: UsbClient) => {
          if (client.deviceId() !== deviceId) {
            return;
          }
          if (this.isTargetClient(client, clientName)) {
            resolve([client]);
            this.off("client-connected", clientCallback);
          }
        };
        if (clientName != null) {
          const targetClients = this.findUsbClient(
            clientName,
            Array.from(this.usbClients.values()),
          );
          if (targetClients.length > 0) {
            resolve(targetClients);
            return;
          }
          this.on("client-connected", clientCallback);
        }
        setTimeout(() => {
          this.off("client-connected", clientCallback);
          let clients = Array.from(this.usbClients.values());
          clients = clients.filter((client) => {
            return client.deviceId() === deviceId;
          });
          resolve(this.findUsbClient(clientName, clients));
        }, timeout);
      }
    });
  }

  private findUsbClient(
    clientName: string | null,
    clients: UsbClient[],
  ): UsbClient[] {
    if (clientName === null) {
      return clients;
    }
    const targetClients = clients.filter((client) => {
      return this.isTargetClient(client, clientName);
    });
    return targetClients;
  }

  private isTargetClient(client: UsbClient, clientName: string | null) {
    if (clientName == null) {
      return false;
    }
    if (
      client?.info?.query?.os === "Android" &&
      client.info.query.raw_info?.AppProcessName === clientName
    ) {
      return true;
    }
    if (
      client?.info?.query?.device_model?.indexOf("iPhone") !== -1 &&
      client.info.query.raw_info?.App === clientName
    ) {
      return true;
    }
    return false;
  }

  // ======================================

  // functions change a little bit

  createClientId(): number {
    if (this.nextClientId > 4294967294) {
      defaultLogger.error("createClientId: clientId overflow...but how?"); // This should never happen in normal usage. There must be a bug.
      return -1;
    }
    return ++this.nextClientId;
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    // remove multiOpenMonitor part & wss part
    this.disableAllClients();
  }

  regiserUsbClient(client: UsbClient) {
    defaultLogger.debug(
      "regiserUsbClient:" + " info:" + JSON.stringify(client.info),
    );
    const existing = this.usbClients.get(client.clientId());
    if (existing) {
      defaultLogger.debug("regiserUsbClient: has exist:" + client.clientId());
      return;
    }
    // register new client
    this.usbClients.set(client.clientId(), client);
    this.emit("client-connected", client);
    this.emit("app-client-connected", client);
    // remove wss.sendClientList
    setClientTimeMap(client);
  }

  unregiserUsbClient(id: number) {
    const existing = this.usbClients.get(id);
    if (!existing) {
      defaultLogger.debug("unregiserUsbClient unknown id:" + id);
      return;
    }
    defaultLogger.debug("unregiserUsbClient:" + JSON.stringify(existing.info));
    // remove selectedClient part, connector facade will handle it
    // unregiser client
    this.usbClients.delete(id);
    this.emit("client-disconnected", id);
    this.emit("app-client-disconnected", id);
    // remove wss.sendClientList
    monitorUnregisterClient(existing, this.usbConnectOpt.retryTime);
  }

  emit<Event extends keyof PhysicalConnectorEvent>(
    event: Event,
    payload: PhysicalConnectorEvent[Event],
  ): void {
    this.events.emit(event, payload);
    // remove traceRecorder part, host will handle it
  }

  registerDevice(device: BaseDevice) {
    const { serial } = device.info;
    const existing = this.devices.get(serial);
    if (existing) {
      defaultLogger.debug("registerDevice: has exists:" + device.serial);
      return;
    }
    defaultLogger.debug("register new device:" + device.serial);
    // register new device
    this.devices.set(device.info.serial, device);
    this.traceRecorder?.recordDeviceRegistered(device.info.serial, {
      os: device.info.os,
      title: device.info.title,
    });
    // remove auto startWatchClient, host will handle it
    this.emit("device-connected", device);
    setDeviceTimeMap(device);
  }

  waitDeviceUsbClients(
    deviceId: string,
    timeout: number = -1,
  ): Promise<UsbClient[]> {
    return new Promise((resolve) => {
      if (!this.devices.has(deviceId)) {
        resolve([]);
      }
      if (timeout < 0) {
        let clients = Array.from(this.usbClients.values());
        clients = clients.filter((client) => {
          return client.deviceId() === deviceId;
        });
        resolve(Array.from(clients.values()));
      } else {
        const handle = (client: UsbClient) => {
          if (client.deviceId() === deviceId) {
            resolve([client]);
          }
        };
        this.on("client-connected", handle);
        setTimeout(() => {
          let clients = Array.from(this.usbClients.values());
          clients = clients.filter((client) => {
            return client.deviceId() === deviceId;
          });
          this.off("client-connected", handle);
          resolve(Array.from(clients.values()));
        }, timeout);
      }
    });
  }

  // ======================================

  // new helper function

  async startWatchClient(
    device: BaseDevice,
    shouldStart: () => boolean = () => true,
  ): Promise<void> {
    if (!shouldStart()) {
      return;
    }
    if (device instanceof AndroidDevice) {
      await (device as AndroidDevice).forwards();
      if (!shouldStart()) {
        return;
      }
    }
    device.startWatchClient();
  }

  closeClient(clientId: number): void {
    const client = this.usbClients.get(clientId);
    if (client) {
      client.close();
    }
  }
}
