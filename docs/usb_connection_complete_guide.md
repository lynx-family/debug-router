# USB Connection Complete Guide - Debug Router
## From Device Plug-in to Message Routing

**Date**: 2026-02-13 (Recreated: 2026-02-18)  
**Source Repositories**:
- **debug-router**: `/Users/bytedance/workspace/codes/debug-router/`
- **hdt-res**: `/Users/bytedance/workspace/codes/hdt-res/`
- **template-assembler**: `/Users/bytedance/workspace/codes/template-assembler/`

---

## Table of Contents

1. [Executive Summary](#executive-summary)
2. [Package Architecture](#package-architecture)
3. [Component Overview](#component-overview)
4. [Device Discovery Flow](#device-discovery-flow)
5. [Port Forwarding Mechanisms](#port-forwarding-mechanisms)
6. [Complete Call Chain](#complete-call-chain)
7. [Message Protocol](#message-protocol)
8. [Threading Model](#threading-model)
9. [USB vs WebSocket Comparison](#usb-vs-websocket-comparison)
10. [Complete File Reference](#complete-file-reference)

---

## Executive Summary

### How USB Connection Works Without QR Code

**Question**: "How does the client know a new device exists without scanning QR code?"

**Answer**: 
1. **OS-level daemons detect USB**: `adb` (Android) and `usbmuxd` (iOS) automatically detect physical USB connections
2. **DebugRouterConnector monitors daemons**: Continuously polls these daemons for device events
3. **Automatic registration**: Device events trigger auto-registration and port forwarding setup
4. **UI notification**: Events propagate to UI via event emitters

**Key Difference from WebSocket**:
- **WebSocket**: Needs schema URL (via QR) to know where to connect
- **USB**: Physical connection + OS daemon = automatic discovery!

### Connection Flow Overview

```
Device Plugged In (USB)
    ↓
OS Daemon Detects (adb/usbmuxd)
    ↓
DebugRouterConnector Monitors
    ↓
Device Manager (Android/iOS) Notified
    ↓
Port Forwarding Set Up
    ↓
Device Registered
    ↓
Event Emitted: 'device-connected'
    ↓
UsbManager Notifies UI
    ↓
User Sees New Device
```

---

## Package Architecture

### Three-Layer Structure

```
┌─────────────────────────────────────────────────────────────┐
│  Layer 3: Consumer Application (hdt-cli)                    │
│  ├─ toolkit.ts: Instantiates DebugRouterDriver             │
│  └─ fakeClient.ts: Bridges USB to WebSocket                │
│  Source: hdt-res/common/packages/hdt-cli/                  │
└─────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────┐
│  Layer 2: Thin Wrapper (@byted-lynx/debug-router-driver)   │
│  ├─ DebugRouterDriver extends DebugRouterConnector         │
│  └─ Just passes options to parent constructor              │
│  Source: npm package (compiled from debug-router)          │
└─────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────┐
│  Layer 1: Core Implementation (@lynx-js/debug-router-      │
│           connector)                                        │
│  ├─ DebugRouterConnector: Main orchestrator                │
│  ├─ AndroidDeviceManager: Android device discovery         │
│  ├─ AndroidDevice: Android port forwarding                 │
│  ├─ iOSDeviceManager: iOS device discovery                 │
│  └─ iOSDevice: iOS tunneling                               │
│  Source: debug-router/debug_router_connector/              │
└─────────────────────────────────────────────────────────────┘
```

**Key Files**:
- **Entry Point**: `hdt-res/common/packages/hdt-cli/src/cli/command/toolkit.ts:152`
- **Wrapper**: `@byted-lynx/debug-router-driver/src/driver/DebugRouterDriver.ts`
- **Core Logic**: `debug-router/debug_router_connector/src/connector/DebugRouterConnector.ts`

---

## Component Overview

### Client Side (PC)

#### 1. UsbManager
**File**: `hdt-res/common/apps/hdt-desktop/src/main/mobile/usb/index.ts`

**Purpose**: High-level USB device management interface

**Key Responsibilities**:
- Device lifecycle management (connect/disconnect events)
- Device information retrieval
- Shell command execution on devices
- Device interaction (click, swipe, input, screenshot)

**Architecture Pattern**:
```
UsbManager (High-level API)
    ↓
hdtServer.getDebugDriver()
    ↓
DebugRouterDriver
  ├─ Package: @byted-lynx/debug-router-driver (thin wrapper)
  ├─ Extends: DebugRouterConnector
  └─ Source: debug-router/debug_router_connector/
    ↓
devices Map<deviceId, IUsbDevice>
usbClients Map<clientId, UsbClient>
```

#### 2. DebugRouterConnector
**File**: `debug-router/debug_router_connector/src/connector/DebugRouterConnector.ts`

**Purpose**: Core orchestrator for device discovery and connection

**Key Methods**:
- `constructor()` (Lines 110-193): Initializes device managers
- `connectDevices()` (Lines 354-361): Starts device listeners
- `startDeviceListeners()` (Lines 419-433): Parallel device manager startup

**Auto-Start Logic**:
```typescript
// Lines 190-192
if (!this.manualConnect) {  // false by default
  this.connectDevices();    // Automatic device discovery!
}
```

#### 3. Device Managers

**AndroidDeviceManager**
- **File**: `debug-router/debug_router_connector/src/device/android/AndroidDeviceManager.ts`
- **Purpose**: Android device discovery via ADB
- **Library**: `@devicefarmer/adbkit`
- **Key Method**: `watchDevices()` (Lines 75-192)

**iOSDeviceManager**
- **File**: `debug-router/debug_router_connector/src/device/ios/iOSDeviceManager.ts`
- **Purpose**: iOS device discovery via usbmuxd
- **Library**: Custom `third_party/usbmux`
- **Key Method**: `watchDevices()` (Lines 70-129)

### Device Side (Mobile)

#### 1. SocketServer
**Files**: 
- Base: `template-assembler/lynx/third_party/debug_router/src/debug_router/native/socket/socket_server_api.{h,cc}`
- POSIX: `template-assembler/lynx/third_party/debug_router/src/debug_router/native/socket/posix/socket_server_posix.{h,cc}`

**Port Allocation Strategy**:
```cpp
const PORT_TYPE kStartPort = 27042;  // Starting port
const int kTryPortCount = 20;        // Try up to 20 ports

// Algorithm: Try ports 27042-27061 until one is available
PORT_TYPE port = kStartPort;
do {
  if (bind(socket_fd, addr, sizeof(addr)) == 0) {
    break; // Success
  }
  port = port + 1;
} while (port < kStartPort + kTryPortCount);
```

#### 2. UsbClient
**Files**: `template-assembler/lynx/third_party/debug_router/src/debug_router/native/socket/usb_client.{h,cc}`

**Purpose**: Handles individual USB connection from PC client

**Message Protocol** (16-byte header):
```
┌─────────────────┬─────────────────┬──────────────────────┐
│  Header (12B)   │ Payload Size(4B)│    Payload (N bytes) │
├─────────────────┼─────────────────┼──────────────────────┤
│ Version  (4B)   │                 │                      │
│ Type     (4B)   │   uint32 size   │   Message content    │
│ Tag      (4B)   │                 │                      │
└─────────────────┴─────────────────┴──────────────────────┘
```

**Threading Model** (4 threads):
- **work_thread_**: Main coordination
- **read_thread_**: Socket read loop
- **write_thread_**: Socket write loop
- **dispatch_thread_**: Message dispatcher

---

## Device Discovery Flow

### Android Device Discovery

**Source**: `debug-router/debug_router_connector/src/device/android/AndroidDeviceManager.ts`

```typescript
// AndroidDeviceManager.watchDevices() (Lines 75-192)

// Step 1: Get ADB client
this.adbClient = await getAdbInstance(this.adbOptions);

// Step 2: Start tracking devices
this.adbClient.trackDevices().then((tracker) => {
  
  // Event: New device added
  tracker.on('add', async (device: Device) => {
    if (device.type === 'device') {  // authorized
      this.registerDevice(adbClient, device);
    }
  });
  
  // Event: Device changed
  tracker.on('change', async (device: Device) => {
    if (device.type === 'device') {
      this.registerDevice(adbClient, device);
    } else {
      this.driver.unregisterDevice(device.id);
    }
  });
  
  // Event: Device removed
  tracker.on('remove', async (device: Device) => {
    this.driver.unregisterDevice(device.id);
  });
});
```

### iOS Device Discovery

**Source**: `debug-router/debug_router_connector/src/device/ios/iOSDeviceManager.ts`

```typescript
// iOSDeviceManager.watchDevices() (Lines 70-129)

// Create usbmux listener
const usbmuxListener = createListener();

// Listen for device events
usbmuxListener.on('attached', (udid: string) => {
  this.handleDeviceConnect(udid);
});

usbmuxListener.on('detached', (udid: string) => {
  this.driver.unregisterDevice(udid);
});
```

---

## Port Forwarding Mechanisms

### Android: ADB Port Forwarding

**File**: `debug-router/debug_router_connector/src/device/android/AndroidDevice.ts`

```typescript
// AndroidDevice.forward() (Lines 51-100+)
private async forward(remotePorts: number[]) {
  const device = this.adb.getDevice(this.serial);
  
  for (let i = 0; i < remotePorts.length; i++) {
    const remotePort = remotePorts[i];  // e.g., 27042
    let hostport = 10000 + randomOffset;
    
    // Execute: adb forward tcp:LOCAL tcp:REMOTE
    await device.forward(
      `tcp:${hostport}`,      // PC side
      `tcp:${remotePort}`     // Device side
    );
    
    this.port.push(hostport);
  }
}
```

**Result**:
```bash
adb forward tcp:10123 tcp:27042
# PC connects to localhost:10123 → reaches device:27042
```

### iOS: usbmuxd Automatic Tunneling

**File**: `debug-router/debug_router_connector/src/device/ios/iOSDevice.ts`

```typescript
// Transparent tunneling via usbmuxd
const tunnel = await getTunnel(27042, { udid: deviceUDID });
// usbmuxd automatically handles USB → TCP bridging
```

---

## Complete Call Chain

```
┌────────────────────────────────────────────────────────────────┐
│ USER: $ hdt-cli toolkit                                        │
└────────────────┬───────────────────────────────────────────────┘
                 ↓
┌────────────────────────────────────────────────────────────────┐
│ 1. toolkit.ts:152                                              │
│    new DebugRouterDriver({ enableAndroid: true })             │
└────────────────┬───────────────────────────────────────────────┘
                 ↓
┌────────────────────────────────────────────────────────────────┐
│ 2. DebugRouterDriver.constructor()                             │
│    super(options) → DebugRouterConnector                       │
└────────────────┬───────────────────────────────────────────────┘
                 ↓
┌────────────────────────────────────────────────────────────────┐
│ 3. DebugRouterConnector.constructor() (Lines 110-193)         │
│    - Creates AndroidDeviceManager                              │
│    - if (!manualConnect) connectDevices()                      │
└────────────────┬───────────────────────────────────────────────┘
                 ↓
┌────────────────────────────────────────────────────────────────┐
│ 4. connectDevices() → startDeviceListeners() (Lines 419-433)  │
│    - Calls watchDevices() for each manager (parallel)          │
└────────────────┬───────────────────────────────────────────────┘
                 ↓
┌────────────────────────────────────────────────────────────────┐
│ 5. AndroidDeviceManager.watchDevices() (Line 107)             │
│    adbClient.trackDevices() ★                                  │
└────────────────────────────────────────────────────────────────┘
```

---

## Message Protocol

### Binary Format (16-byte header + payload)

```
Header Structure:
┌─────────────────┬─────────────────┬──────────────────────┐
│ Version (4B)    │ Payload Size(4B)│    Payload (N bytes) │
│ Type (4B)       │                 │                      │
│ Tag (4B)        │                 │                      │
└─────────────────┴─────────────────┴──────────────────────┘

Constants:
- kFrameProtocolVersion = 1
- kPTFrameTypeTextMessage = 1
- kFrameDefaultTag = 1
- kFrameHeaderLen = 12
- kPayloadSizeLen = 4
```

---

## Threading Model

### UsbClient Thread Architecture

```
┌────────────────────────────────────────────────────────────┐
│  UsbClient (4 threads per connection)                      │
├────────────────────────────────────────────────────────────┤
│  work_thread_           Main coordination                  │
│  read_thread_           Socket reader → incoming_queue     │
│  write_thread_          outgoing_queue → Socket writer     │
│  dispatch_thread_       incoming_queue → OnMessage()       │
└────────────────────────────────────────────────────────────┘
```

---

## USB vs WebSocket Comparison

| Aspect | USB | WebSocket |
|--------|-----|-----------|
| **Transport** | TCP (localhost) | WebSocket (network) |
| **Discovery** | adb/usbmuxd | Schema URL (QR) |
| **Ports** | 27042-27061 | Specified in schema |
| **Message Format** | Binary (16B header) | WebSocket frames |
| **Connection** | Device listens, PC connects | Device connects to server |
| **Latency** | Lower (loopback) | Higher (network) |
| **Port Forwarding** | Required | Not needed |

---

## Complete File Reference

### Client Side (PC)

| Component | File | Lines | Purpose |
|-----------|------|-------|---------|
| **Entry** | hdt-res/common/packages/hdt-cli/src/cli/command/toolkit.ts | 152 | Driver instantiation |
| **Wrapper** | @byted-lynx/debug-router-driver/src/driver/DebugRouterDriver.ts | 37-65 | Extends connector |
| **Core** | debug-router/debug_router_connector/src/connector/DebugRouterConnector.ts | 110-193 | Main orchestrator |
| **Android Manager** | debug-router/debug_router_connector/src/device/android/AndroidDeviceManager.ts | 75-192 | ADB tracking |
| **Android Device** | debug-router/debug_router_connector/src/device/android/AndroidDevice.ts | 51-100+ | Port forwarding |
| **iOS Manager** | debug-router/debug_router_connector/src/device/ios/iOSDeviceManager.ts | 70-129 | usbmux listener |
| **USB Manager** | hdt-res/common/apps/hdt-desktop/src/main/mobile/usb/index.ts | 8-19 | Event handlers |

### Device Side (Mobile)

| Component | File | Purpose |
|-----------|------|---------|
| **Core** | template-assembler/lynx/third_party/debug_router/src/debug_router/native/core/debug_router_core.{h,cc} | Dual transceiver |
| **Socket Server** | template-assembler/lynx/third_party/debug_router/src/debug_router/native/socket/posix/socket_server_posix.{h,cc} | TCP server |
| **USB Client** | template-assembler/lynx/third_party/debug_router/src/debug_router/native/socket/usb_client.{h,cc} | Connection handler |

---

## Quick Reference

### Key Concepts
1. **No QR Code for USB**: Physical connection + OS daemon = auto-discovery
2. **Auto-Start**: `manualConnect: false` (default) starts immediately
3. **Port Forwarding**: Android (adb forward), iOS (getTunnel)
4. **Ports**: Device listens on 27042-27061
5. **Protocol**: 16-byte header + payload
6. **Threading**: 4 threads per connection

### Call Chain Summary
```
hdt-cli toolkit
  → DebugRouterDriver()
    → DebugRouterConnector()
      → AndroidDeviceManager.watchDevices()
        → adbClient.trackDevices() ★
```

---

**Document Version**: 1.1  
**Created**: 2026-02-13  
**Recreated**: 2026-02-18  
**Status**: Complete - Based on actual source code
