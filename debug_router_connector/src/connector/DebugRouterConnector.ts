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
import { DebugerRouterDriverEvents } from "../utils/type";
import { WebSocketController } from "../websocket/WebSocketServer";
import detectPort from "detect-port";
import { address } from "ip";
import { defaultLogger } from "../utils/logger";
import {
  getDriverReportService,
  DriverReportService,
  setDriverReportService,
} from "../report/interface/DriverReportService";
import { Client } from "./Client";
import { WebSocketClient } from "../websocket/WebSocketConnection";
import {
  DefaultMultiOpenCallback,
  MultiOpenCallback,
  MultiOpenStatus,
} from "./MultiOpenCallBack";
import fs from "fs";
import * as fslock from "../utils/file_lock";
import { DriverClient } from "./DriverClient";
import { lockDir } from "../utils/file_lock";
import {
  monitorUnregisterClient,
  monitorUnregisterDevice,
  setClientTimeMap,
  setDeviceTimeMap,
} from "./MonitorUtils";

export type devOption = {
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
  enableWebSocket?: boolean;
  websocketOption?: {
    port?: number;
    roomId?: string;
  };
  networkDeviceOpt?: {
    ip: string;
    // a network device can have multi debugger clients
    port: number[];
  };
  reportService?: DriverReportService | null;
};

const DEFAULT_DEV_SERVE_PORT = 19783;

export class DebugRouterConnector {
  private readonly events = new EventEmitter();
  reportService: DriverReportService | null = null;
  readonly devices = new Map<string, BaseDevice>();
  readonly usbClients = new Map<number, UsbClient>();
  private readonly manualConnect;
  readonly enableWebSocket;
  private selectedClient: UsbClient | undefined;
  private nextClientId: number = 0;
  private enableAndroid: boolean;
  private enableIOS: boolean;
  private enableHarmony: boolean;
  private enableDesktop: boolean;
  private readonly enableNetworkDevice: boolean;
  private readonly driverClient: DriverClient;
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
  private multiOpenCallback: MultiOpenCallback = new DefaultMultiOpenCallback();
  private monitoring: boolean = false;
  wssPort: number = DEFAULT_DEV_SERVE_PORT;
  wssHost: string | undefined;
  roomId: string | undefined;
  wss: WebSocketController | null = null;
  private currentStatus: MultiOpenStatus = MultiOpenStatus.unInit;
  private devicesManager: Set<DeviceManager>;
  constructor(
    option: devOption = {
      manualConnect: false,
      enableWebSocket: false, // deprecated
      enableAndroid: true,
      enableIOS: true,
      enableHarmony: true,
      enableDesktop: false,
      enableNetworkDevice: false,
      websocketOption: {},
      reportService: null,
    },
  ) {
    setDriverReportService(option.reportService ?? null);
    getDriverReportService()?.init(option.manualConnect);
    const msg = "DebugRouterOption:" + JSON.stringify(option);
    defaultLogger.debug(msg);
    getDriverReportService()?.report(
      "DebugRouterConnectorInit",
      {},
      { option: msg },
    );
    if (!option.manualConnect) {
      getDriverReportService()?.report(
        "DriverInitOfNoManualConnect",
        {},
        { option: msg },
      );
    }
    this.prepareDriverDataDir();
    this.startMonitorMultiOpen();
    this.manualConnect = option.manualConnect;
    this.enableWebSocket = option.enableWebSocket;
    this.roomId = option.websocketOption?.roomId;
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
    this.devicesManager = new Set<DeviceManager>();
    this.driverClient = new DriverClient(this.createClientId());
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
    if (!this.manualConnect) {
      this.connectDevices();
    }
  }

  setMultiOpenCallback(callback: MultiOpenCallback) {
    this.multiOpenCallback = callback;
  }
  prepareDriverDataDir() {
    fslock.clearLockFileWhenProcessExit();
    try {
      if (!fs.existsSync(fslock.driver_dir)) {
        fs.mkdirSync(fslock.driver_dir);
        return;
      }
    } catch (e: any) {
      getDriverReportService()?.report("multi_open_error", null, {
        error: `prepareDriverDataDir err: ${e?.message}`,
      });
    }
    fslock.clearLockFile();
  }
  startMonitorMultiOpen() {
    if (process.env.DriverCloseMultiOpen === "true") {
      defaultLogger.warn("DriverCloseMultiOpen === true");
      return;
    }
    defaultLogger.info("startMonitorMultiOpen");
    this.monitorLatestDriverProcessFileSafely();
    setInterval(() => {
      this.monitorLatestDriverProcessFileSafely();
    }, 500);
  }

  // monitor LatestDriverProcessFile in connector data dir.
  // 1. if LatestDriverProcessFile doesn't exist or this.currentStatus === MultiOpenStatus.unInit
  // update current process-id to LatestDriverProcessFile

  // 2. if LatestDriverProcessFile's pid !== current process-id && this.currentStatus === MultiOpenStatus.attached
  // disableAllClients and call this.multiOpenCallback.statusChanged(MultiOpenStatus.unattached);
  monitorLatestDriverProcessFile() {
    if (this.monitoring) {
      defaultLogger.debug("has monitored, just return");
      return;
    }
    defaultLogger.debug("start monitor...");
    this.monitoring = true;
    fslock.lock((acquiredLock: boolean) => {
      if (!acquiredLock) {
        defaultLogger.debug("doesn't get lock");
        this.monitoring = false;
        return;
      }
      defaultLogger.debug("get lock");
      try {
        if (this.currentStatus === MultiOpenStatus.unInit) {
          this.updateLatestProcess();
        } else {
          const data: string = fs.readFileSync(
            `${fslock.driver_dir}/LatestDriverProcess`,
            "utf-8",
          );
          defaultLogger.debug("LastDriverProcessID:" + data);
          if (data !== `${process.pid}`) {
            if (this.currentStatus === MultiOpenStatus.attached) {
              this.disableAllClients();
              this.currentStatus = MultiOpenStatus.unattached;
              this.multiOpenCallback.statusChanged(MultiOpenStatus.unattached);
            } else {
              // TODO when unattached don't need monitor until activation again
              defaultLogger.debug("current connector has unattached");
            }
          } else {
            defaultLogger.debug("current connector has attached");
          }
        }
      } catch (err: any) {
        if (err?.message?.indexOf("ENOENT") !== -1) {
          this.updateLatestProcess();
        } else {
          defaultLogger.debug(err?.message);
          getDriverReportService()?.report("multi_open_error", null, {
            error: `readFileSync: ${err?.message}`,
          });
        }
      }
      fslock.unlock((err: Error | null) => {
        if (err === null) {
          defaultLogger.debug("unlock ok");
        } else if (err?.message?.indexOf("ENOENT") !== -1) {
          fslock.resetLockStatus();
          defaultLogger.debug("unlock ok");
        } else {
          getDriverReportService()?.report("multi_open_error", null, {
            error: `fslock.unlock error: ${err?.message}`,
          });
          defaultLogger.debug("unlock failed");
        }
        this.monitoring = false;
      });
    });
  }

  private updateLatestProcess() {
    if (!fs.existsSync(lockDir)) {
      defaultLogger.debug("updateLatestProcess: lockfile is removed!");
      return;
    }
    defaultLogger.info("MultiOpen: switch to attached");
    fs.writeFileSync(
      `${fslock.driver_dir}/LatestDriverProcess`,
      `${process.pid}`,
      "utf-8",
    );
    this.currentStatus = MultiOpenStatus.attached;
    this.multiOpenCallback.statusChanged(MultiOpenStatus.attached);
  }

  private monitorLatestDriverProcessFileSafely() {
    try {
      this.monitorLatestDriverProcessFile();
    } catch (err: any) {
      getDriverReportService()?.report("multi_open_error", null, {
        error: `monitorLatestDriverProcessFileSafely error: ${err?.message}`,
      });
    }
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

  startWatchAllClients(force: boolean = true) {
    defaultLogger.debug("startWatchAllClients");
    if (!force && this.currentStatus === MultiOpenStatus.attached) {
      defaultLogger.debug("startWatchAllClients: has already attached");
      return;
    }
    this.currentStatus = MultiOpenStatus.unInit;
    fslock.clearLockFile();
    this.monitorLatestDriverProcessFile();
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
          clients = await this.waitDeviceUsbCliens(deviceId, timeout);
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

  on<Event extends keyof DebugerRouterDriverEvents>(
    event: Event,
    callback: (payload: DebugerRouterDriverEvents[Event]) => void,
  ): void {
    this.events.on(event, callback);
  }

  off<Event extends keyof DebugerRouterDriverEvents>(
    event: Event,
    callback: (payload: DebugerRouterDriverEvents[Event]) => void,
  ): void {
    this.events.off(event, callback);
  }

  emit<Event extends keyof DebugerRouterDriverEvents>(
    event: Event,
    payload: DebugerRouterDriverEvents[Event],
  ): void {
    this.events.emit(event, payload);
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
    if (
      !this.manualConnect &&
      this.currentStatus === MultiOpenStatus.attached
    ) {
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
    // register new client
    this.usbClients.set(client.clientId(), client);
    this.emit("client-connected", client);
    this.emit("app-client-connected", client);
    this.handleUsbClienChange();
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
    this.handleUsbClienChange();
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

  private waitDeviceUsbCliens(
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

  handleUsbMessage(id: number, message: string) {
    if (this.wss) {
      const response = JSON.parse(message);
      if (response.data && response.data["sender"]) {
        response.data["sender"] = id;
      }
      if (
        response.data?.data &&
        response.data?.data.hasOwnProperty("client_id")
      ) {
        response.data.data["client_id"] = id;
      }
      this.wss.sendMessageToWeb(JSON.stringify(response));
    }
  }

  handleWsMessage(id: number, message: string) {
    const client = this.usbClients.get(id);
    if (client) {
      const data = JSON.parse(message);
      if (
        data?.data?.type === "UsbConnect" ||
        data?.data?.type === "UsbConnectAck"
      )
        return;
      if (data?.data?.data?.client_id) {
        data.data.data.client_id = -1;
      }
      client.sendMessage(data);
    }
  }

  handleUsbClienChange() {
    if (this.wss) {
      this.wss.sendClientList();
    }
  }

  handleUsbDeviceChange() {
    if (this.wss) {
      this.wss.sendClientList();
    }
  }

  getAllAppClients() {
    const clients: Client[] = [];
    this.getAllUsbClients().forEach((client: UsbClient) => {
      clients.push(client);
    });
    if (this.enableWebSocket && this.wss) {
      this.wss
        .getAllWebsocketAppClients()
        .forEach((client: WebSocketClient) => {
          clients.push(client);
        });
    }
    return clients;
  }

  // send message to web platform
  sendMessageToWeb(message: string) {
    if (!this.enableWebSocket) {
      defaultLogger.warn("enableWebSocket isn't opened!");
      return;
    }
    if (this.wss === null) {
      defaultLogger.warn("websocket server hasn't started up");
      return;
    }
    this.wss.sendMessageToWeb(message);
  }

  // send message to app(include apps connected by usb and wifi)
  sendMessageToApp(id: number, message: string) {
    if (!this.enableWebSocket) {
      defaultLogger.warn("enableWebSocket isn't opened!");
      return;
    }
    if (this.wss === null) {
      defaultLogger.warn("websocket server hasn't started up");
      return;
    }
    this.wss?.sendMessageToApp(id, message);
  }

  async startWSServer(): Promise<void> {
    return new Promise(async (resolve) => {
      if (this.enableWebSocket) {
        const port = this.wssPort;
        this.wssPort = await detectPort(port);
        this.wssHost = `${address()}:${this.wssPort}`;
        getDriverReportService()?.report("websocket_server_init", null, {
          port: "wssPort:" + this.wssHost,
        });
        this.wss = new WebSocketController(this, {
          port: this.wssPort,
          host: this.wssHost,
          roomId: this.roomId,
          callback: resolve,
        });
      } else {
        resolve();
      }
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

  public getDriverClient(): DriverClient {
    return this.driverClient;
  }
}
