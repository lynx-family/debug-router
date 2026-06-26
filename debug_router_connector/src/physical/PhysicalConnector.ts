// Copyright 2024 The Lynx Authors. All rights reserved.
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
import { RequireMessageType, ResponseMessageType } from "../utils/type";
import { defaultLogger } from "../utils/logger";
import {
  getDriverReportService,
  DriverReportService,
  setDriverReportService,
} from "../report/interface/DriverReportService";
import { PhysicalConnectorEvent } from "../utils/type";
import {
  monitorUnregisterClient,
  monitorUnregisterDevice,
  setClientTimeMap,
  setDeviceTimeMap,
} from "./MonitorUtils";
import type {
  ConnectionTraceOptions,
  ConnectionTraceRecorder,
} from "../trace/ConnectionTraceRecorder";

export type PhysicalConnectorOption = {
  enableWebSocket?: boolean;
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
  reportService?: DriverReportService | null;
  connectionTrace?: ConnectionTraceOptions;
  traceRecorder?: ConnectionTraceRecorder | null;
};

export class PhysicalConnector {
  private readonly events = new EventEmitter();
  reportService: DriverReportService | null = null;
  readonly devices = new Map<string, BaseDevice>();
  readonly usbClients = new Map<number, UsbClient>();
  readonly enableWebSocket;
  private readonly manualConnect;
  selectedClient: UsbClient | undefined;
  private nextClientId: number = 0;
  private enableAndroid: boolean;
  private enableIOS: boolean;
  private enableHarmony: boolean;
  private enableDesktop: boolean;
  private readonly enableNetworkDevice: boolean;
  private autoListenClients = true;
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
      enableWebSocket: false,
      manualConnect: false,
      enableAndroid: true,
      enableIOS: true,
      enableHarmony: true,
      enableDesktop: false,
      enableNetworkDevice: false,
      reportService: null,
      traceRecorder: null,
    },
  ) {
    setDriverReportService(option.reportService ?? null);
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
    this.manualConnect = option.manualConnect;
    this.enableWebSocket = option.enableWebSocket;
    this.enableAndroid = option.enableAndroid ?? true;
    this.adbOption = option.adbHostPort;
    this.enableIOS =
      process.platform !== "darwin" ? false : option.enableIOS ?? true;
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
    this.setOptionByEnv();
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
    if (this.enableNetworkDevice && this.networkDeviceOpt) {
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

  startWatchAllClients(force: boolean = true) {
    defaultLogger.debug("PhysicalConnector startWatchAllClients");
    this.devices.forEach((device) => {
      if (device instanceof AndroidDevice) {
        (device as AndroidDevice).forwards().then(() => {
          device.startWatchClient();
        });
      } else {
        device.startWatchClient();
      }
    });
  }

  createClientId(): number {
    if (this.nextClientId > 4294967294) this.nextClientId = 0;
    return ++this.nextClientId;
  }

  async connectDevices(
    timeout: number = -1,
    serial: string | null = null,
    isAutoListenClients: boolean = true,
  ): Promise<BaseDevice[]> {
    this.autoListenClients = isAutoListenClients;
    await this.startDeviceListeners();
    return this.getDevices(timeout, serial);
  }

  // clientName:
  // for android: processName
  // for ios: AppName
  async connectUsbClients(
    deviceId: string,
    timeout: number = -1,
    waitTimeout: boolean = true,
    clientName: string | null = null,
  ): Promise<UsbClient[]> {
    defaultLogger.debug(
      "connectUsbClients of :" +
        deviceId +
        " waitTimeout:" +
        waitTimeout +
        " timeout:" +
        timeout,
    );
    return new Promise(async (resolve, reject) => {
      const device = this.devices.get(deviceId);
      if (device) {
        device.startWatchClient();
        let clients: UsbClient[];
        if (waitTimeout) {
          clients = await this.getDeviceUsbClients(
            deviceId,
            timeout,
            clientName,
          );
        } else {
          clients = await this.waitDeviceUsbClients(deviceId, timeout);
        }
        device.stopWatchClient();
        const clients_infos = clients.map((client) => {
          return client.info;
        });
        defaultLogger.debug(
          "connectUsbClients: clients:" + JSON.stringify(clients_infos),
        );
        resolve(clients);
      } else {
        defaultLogger.debug("connectUsbClients: resolve device == null");
        resolve([]);
      }
    });
  }

  selecteUsbClient(id: number) {
    if (this.usbClients.has(id)) {
      this.selectedClient = this.usbClients.get(id);
    }
  }

  addDeviceManager(manager: DeviceManager) {
    this.devicesManager.add(manager);
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

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.disableAllClients();
  }

  emit<Event extends keyof PhysicalConnectorEvent>(
    event: Event,
    payload: PhysicalConnectorEvent[Event],
  ): void {
    this.events.emit(event, payload);
  }

  registerDevice(device: BaseDevice, shouldStartWatchClient?: boolean) {
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
    const shouldWatchClient =
      shouldStartWatchClient ?? this.autoListenClients;
    if (!this.manualConnect && shouldWatchClient) {
      device.startWatchClient();
    }
    this.emit("device-connected", device);
    setDeviceTimeMap(device);
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

  regiserUsbClient(client: UsbClient) {
    defaultLogger.debug(
      "regiserUsbClient:" + " info:" + JSON.stringify(client.info),
    );
    const existing = this.usbClients.get(client.clientId());
    if (existing) {
      defaultLogger.debug("regiserUsbClient: has exist:" + client.clientId);
      return;
    }
    const existingSameRuntime = this.findRegisteredUsbClientByIdentity(client);
    if (existingSameRuntime) {
      defaultLogger.debug(
        "regiserUsbClient: has same runtime:" +
          JSON.stringify(existingSameRuntime.info),
      );
      client.close();
      return;
    }
    // register new client
    this.usbClients.set(client.clientId(), client);
    this.emit("client-connected", client);
    this.emit("app-client-connected", client);
    setClientTimeMap(client);
  }

  unregiserUsbClient(id: number) {
    const existing = this.usbClients.get(id);
    if (!existing) {
      defaultLogger.debug("unregiserUsbClient unknown id:" + id);
      return;
    }
    defaultLogger.debug("unregiserUsbClient:" + JSON.stringify(existing.info));
    if (this.selectedClient && this.selectedClient.info.id === id) {
      this.selectedClient = undefined;
    }
    // unregiser client
    this.usbClients.delete(id);
    this.emit("client-disconnected", id);
    this.emit("app-client-disconnected", id);
    monitorUnregisterClient(existing, this.usbConnectOpt.retryTime);
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

  waitDeviceUsbClients(
    deviceId: string,
    timeout: number = -1,
  ): Promise<UsbClient[]> {
    return new Promise((resolve) => {
      if (!this.devices.has(deviceId)) {
        resolve([]);
        return; 
      }
      const currentClients = this.findUsbClientsByDeviceId(deviceId);
      if (timeout < 0 || currentClients.length > 0) {
        resolve(currentClients);
        return; 
      }

      const handle = (client: UsbClient) => {
        if (client.deviceId() === deviceId) {
          cleanup();
          resolve([client]);
        }
      };
      const cleanup = () => {
        clearTimeout(timer);
        this.off("client-connected", handle);
      };

      const timer = setTimeout(() => {
        cleanup();
        resolve(this.findUsbClientsByDeviceId(deviceId));
      }, timeout);

      this.on("client-connected", handle);
    });
  }

  private findUsbClientsByDeviceId(deviceId: string): UsbClient[] {
    return this.getAllUsbClients()
      .filter((client) => client.deviceId() === deviceId);
  }

  private findRegisteredUsbClientByIdentity(
    client: UsbClient,
  ): UsbClient | undefined {
    return this.getAllUsbClients().find((existing) => {
      return (
        existing.deviceId() === client.deviceId() &&
        existing.info?.port === client.info?.port &&
        stringifyStableJson(existing.info?.query?.raw_info ?? null) ===
          stringifyStableJson(client.info?.query?.raw_info ?? null)
      );
    });
  }

  handleUsbMessage(id: number, message: string) {
    this.emit("usb-client-message", { id, message });
  }

  // unused methods, for future use:DaemonHost

  sendMessage(clientId: number, message: unknown): void {
    const client = this.usbClients.get(clientId);
    if (client) {
      client.sendMessage(message);
    }
  }

  sendRawMessage(
    clientId: number,
    message: RequireMessageType,
  ): Promise<ResponseMessageType> {
    const client = this.usbClients.get(clientId);
    if (!client) {
      return Promise.reject(new Error("client not found:" + clientId));
    }
    return client.sendRawMessage(message);
  }

  closeClient(clientId: number): void {
    const client = this.usbClients.get(clientId);
    if (client) {
      client.close();
    }
  }

  // unused methods end

  getAllAppClients() {
    return this.getAllUsbClients();
  }

  getAllPhysicalClients(): UsbClient[] {
    return this.getAllUsbClients();
  }

  disableAllClients() {
    defaultLogger.info("disableAllClients");
    // close usb autoConnect
    this.devices.forEach((device) => {
      device.stopWatchClient();
    });
    this.getAllAppClients().forEach((client) => {
      client.close();
    });
  }

  private setOptionByEnv() {
    if (process.env.DriverEnableAndroid === "false") {
      this.enableAndroid = false;
      defaultLogger.warn("set DriverEnableAndroid === false");
    }
    if (process.env.DriverEnableIOS === "false") {
      this.enableIOS = false;
      defaultLogger.warn("set DriverEnableIOS === false");
    }
    if (process.env.DriverEnableDesktop === "false") {
      this.enableDesktop = false;
      defaultLogger.warn("set DriverEnableDesktop === false");
    }
  }
}

function stringifyStableJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => stringifyStableJson(item)).join(",")}]`;
  }

  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map(
      (key) =>
        `${JSON.stringify(key)}:${stringifyStableJson(record[key])}`,
    )
    .join(",")}}`;
}
