// Copyright 2024 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

import AndroidDevice from "../device/android/AndroidDevice";
import { BaseDevice } from "../device/BaseDevice";
import MacDevice from "../device/desktop/MacDevice";
import WindowsDevice from "../device/desktop/WindowsDevice";
import iOSDevice from "../device/ios/iOSDevice";
import NetworkDevice from "../device/network/NetworkDevice";
import { getDriverReportService } from "../report/interface/DriverReportService";
import { UsbClient } from "../usb/Client";

let deviceTimeMap: Map<string, number> = new Map();
let clientTimeMap: Map<number, number> = new Map();

export function setDeviceTimeMap(device: BaseDevice) {
  deviceTimeMap.set(device.info.serial, new Date().getTime());
  getDriverReportService()?.report("register_new_device", null, {
    serial: device.info.serial,
    deviceType: getDeviceType(device),
  });
}

export function monitorUnregisterDevice(device: BaseDevice, retryTime: number) {
  const currentTime = new Date().getTime();
  const deviceTime = deviceTimeMap.get(device.info.serial);
  if (deviceTime && currentTime - deviceTime < retryTime) {
    getDriverReportService()?.report("quick_lose_device", null, {
      curTime: currentTime,
      serial: device.info.serial,
      dur: currentTime - deviceTime,
      deviceType: getDeviceType(device),
    });
    deviceTimeMap.delete(device.info.serial);
  }
}

function getDeviceType(device: BaseDevice): string {
  if (device instanceof AndroidDevice) {
    return "Android";
  }
  if (device instanceof iOSDevice) {
    return "iOS";
  }
  if (device instanceof MacDevice) {
    return "Mac";
  }
  if (device instanceof WindowsDevice) {
    return "Windows";
  }
  if (device instanceof NetworkDevice) {
    return "Network";
  }
  return "Unknown";
}

export function setClientTimeMap(client: UsbClient) {
  clientTimeMap.set(client.clientId(), new Date().getTime());
  getDriverReportService()?.report("register_new_client", null, {
    client: JSON.stringify(client.info.query?.raw_info) ?? "unknown",
  });
}

export function monitorUnregisterClient(client: UsbClient, retryTime: number) {
  const currentTime = new Date().getTime();
  const clientTime = clientTimeMap.get(client.clientId());
  if (clientTime && currentTime - clientTime < retryTime) {
    getDriverReportService()?.report("quick_lose_client", null, {
      curTime: currentTime,
      dur: currentTime - clientTime,
      client: JSON.stringify(client.info.query?.raw_info) ?? "unknown",
    });
    clientTimeMap.delete(client.clientId());
  }
}
