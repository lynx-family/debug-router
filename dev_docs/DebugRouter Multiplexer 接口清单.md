# DebugRouter Multiplexer 接口清单

本文基于 `DebugRouter Multiplexer Connector 拆分类图.md` 梳理目标接口。这里的接口是设计层面的 TypeScript 形态清单，用于约束模块边界和后续落地实现；具体文件名、可见性和泛型可在实现阶段按代码规范微调。

约定：

- 对现有接入方保持兼容的成员正常列在类接口中。
- 内部实现成员直接放在对应类接口内，并用 `// internal` 注释标注；落地实现时使用 `private` 或 `protected` 表达。
- mux enabled 时，connector 进程只持有 `MultiplexerDevice`、`MultiplexerUsbClient` 镜像对象。
- 真实 `BaseDevice`、`UsbClient` 只由 `PhysicalConnector` 持有；mux daemon 与 mux disabled 的 legacy fallback 都可以组合它。
- control RPC 只传输可序列化 DTO，不跨进程传递 `BaseDevice` 或 `UsbClient` 实例。
- C/S 多版本共存依赖 `daemon.json.protocolVersion` 做版本仲裁，不依赖业务 RPC 猜测版本。
- 高版本 daemon 必须兼容低版本 connector；低版本 daemon 遇到高版本 connector 时由 `MultiplexerDaemonManager` 触发强制替换。
- RPC 参数、响应和事件模型遵循“只增不改”：只能新增可选字段或新增事件/RPC 方法，不能删除老字段、改变老字段语义或把可选字段改成必填字段。

版本兼容的三条基本规则：

1. 握手看版本：`MultiplexerDiscovery` 读取 `daemon.json`，通过 `protocolVersion` 完成版本仲裁。
2. 高容低，低顶高：如果 daemon 协议版本高于 connector，本 connector 按自身低版本能力接入；如果 daemon 协议版本低于 connector，`MultiplexerDaemonManager` 负责替换 daemon，并依靠全局断线重连让其他 connector 自动切到新 daemon。
3. 接口只增不改：跨进程 DTO 保持向后兼容，新增能力以可选字段、新 RPC 方法或新事件表达。

## 1. 对外兼容 API

### DebugRouterConnector

`DebugRouterConnector` 保持旧 connector 的主要使用方式，但在 Multiplexer 开启时只返回本进程内的 mux 镜像对象，不返回真实物理连接对象。

```ts
export interface DebugRouterConnector {
  readonly devices: Map<string, MultiplexerDevice>;
  readonly usbClients: Map<number, MultiplexerUsbClient>;
  readonly enableWebSocket: boolean;
  readonly traceRecorder: ConnectionTraceRecorder | null;
  reportService: DriverReportService | null;
  readonly adbOption: any;
  readonly hdcOption: any;
  readonly usbConnectOpt: {
      retryTime: number;
  };
  wssPort: number;
  wssHost: string | undefined;
  roomId: string | undefined;
  wss: WebSocketController | null;
  
  constructor(option?: DebugRouterConnectorOption);

  setMultiOpenCallback(callback: MultiOpenCallback): void;
  disableAllClients(): void;
  startWatchAllClients(force?: boolean): void;
  createClientId(): number;
  connectDevices(
    timeout?: number,
    serial?: string | null,
    isAutoListenClients?: boolean,
  ): Promise<MultiplexerDevice[]>;

  connectUsbClients(
    deviceId: string,
    timeout?: number,
    waitTimeout?: boolean,
    clientName?: string | null,
  ): Promise<MultiplexerUsbClient[]>;

  selecteUsbClient(id: number): void;
  addDeviceManager(manager: DeviceManager): void;

  on<Event extends keyof MultiplexerDriverEvents>(
    event: Event,
    callback: (payload: MultiplexerDriverEvents[Event]) => void,
  ): void;

  off<Event extends keyof MultiplexerDriverEvents>(
    event: Event,
    callback: (payload: MultiplexerDriverEvents[Event]) => void,
  ): void;

  emit<Event extends keyof MultiplexerDriverEvents>(
    event: Event,
    payload: MultiplexerDriverEvents[Event],
  ): void;

  registerDevice(device: MultiplexerDevice): void;
  unregisterDevice(serial: string): void;
  regiserUsbClient(client: MultiplexerUsbClient): void;
  unregiserUsbClient(id: number): void;

  getDevices(
    timeout?: number,
    serial?: string | null,
  ): Promise<MultiplexerDevice[]>;

  getAllUsbClients(): MultiplexerUsbClient[];

  getDeviceUsbClients(
    deviceId: string,
    timeout?: number,
    clientName?: string | null,
  ): Promise<MultiplexerUsbClient[]>;

  handleUsbMessage(id: number, message: string): void;
  handleWsMessage(id: number, message: string): void;
  handleUsbClienChange(): void;
  handleUsbDeviceChange(): void;

  getAllAppClients(): Client[];
  sendMessageToWeb(message: string): void;
  sendMessageToApp(id: number, message: string): void;
  startWSServer(): Promise<void>;

  getDriverClient(): DriverClient;


  // internal: connector 侧代理和本地状态，落地实现时使用 private/protected。
  readonly remoteClient: MultiplexerRemoteClient;
  readonly legacyMultiOpenGuard: LegacyMultiOpenGuard;
  readonly physicalConnector?: PhysicalConnector;
  readonly driverClient: DriverClient;
  readonly selectedClient?: MultiplexerUsbClient;
  readonly networkDeviceOpt?: {
    ip: string;
    port: number[];
  };

  applySnapshot(snapshot: Snapshot): void;
  applyHostEvent(event: ControlEvent): void;
  findDevice(serial: string | null): MultiplexerDevice[];
  findUsbClient(
    clientName: string | null,
    clients: MultiplexerUsbClient[],
  ): MultiplexerUsbClient[];
  isTargetClient(
    client: MultiplexerUsbClient,
    clientName: string | null,
  ): boolean;
  waitDeviceUsbCliens(
    deviceId: string,
    timeout?: number,
  ): Promise<MultiplexerUsbClient[]>;
  setOptionByEnv(): void;
}

export type MultiplexerDriverEvents = {
  "device-connected": MultiplexerDevice;
  "device-disconnected": MultiplexerDevice;
  "client-connected": MultiplexerUsbClient;
  "client-disconnected": number;
  "usb-client-message": {
    id: number;
    message: string;
  };
  "ws-client-message": {
    id: number;
    message: string;
  };
  "ws-web-message": {
    id: number;
    message: string;
  };
  "websocket-app-client-connected": WebSocketClientSnapshot;
  "websocket-app-client-disconnected": number;
  "websocket-web-client-connected": WebSocketClientSnapshot;
  "websocket-web-client-disconnected": number;
  "app-client-connected": MultiplexerUsbClient | WebSocketClientSnapshot;
  "app-client-disconnected": number;
};

export type DebugRouterConnectorOption = PhysicalConnectorOption & {
  enableMultiplexer?: boolean;
  enableProxy?: boolean;
  multiplexerDaemonIdleTimeout?: number;
  proxyDaemonIdleTimeout?: number;
  enableWebSocket?: boolean;
  websocketOption?: {
    port?: number;
    roomId?: string;
  };
};
```

### MultiplexerDevice

`MultiplexerDevice` 是 connector 进程内的设备镜像，保留 `BaseDevice` 兼容外形，但不持有真实 watcher。

```ts
export interface MultiplexerDevice {
  readonly info: DeviceDescription;
  constructor(driver: DebugRouterConnector, info: DeviceDescription);
  get ports(): number[];
  get serial(): string;
  abstract getHost(): string;
  startWatchClient(): void;
  stopWatchClient(): Promise<void>;
  disConnect(): void;

  // internal: connector 侧远端代理引用，落地实现时使用 private。
  readonly remoteClient: MultiplexerRemoteClient;
}
```

### MultiplexerUsbClient

`MultiplexerUsbClient` 是 connector 进程内的 runtime client 镜像。发送类方法通过 `MultiplexerRemoteClient` 转发到 daemon。

```ts
export interface MultiplexerUsbClient {
  readonly info: ClientDescription;
  readonly connection: Connection;
  constructor(info: ClientDescription, connection: Connection);

  clientId(): number;
  deviceId(): string;

  sendCustomizedMessage(
    method: string,
    params?: Object | string,
    sessionId?: number,
    type?: string,
  ): Promise<string>;

  sendRawMessage(message: RequireMessageType): Promise<ResponseMessageType>;
  sendMessage(message: unknown): void;
  sendClientMessage(method: string, params?: Object): Promise<string>;

  close(): void;

  on(event: string, callback: EventHandler): void;
  onAllEvents(callback: CDPEventHandler): void;
  once(event: string, callback: EventHandler): void;
  off(event: string, callback: EventHandler): void;

  // internal: connector 侧远端代理和本地事件派发，落地实现时使用 private/protected。
  readonly remoteClient: MultiplexerRemoteClient;
  emit(event: string, ...params: unknown[]): void;
}
```

## 2. Connector 内部 API

### MultiplexerRemoteClient

`MultiplexerRemoteClient` 是 connector 侧 control WebSocket 代理，负责确保 daemon 可用、建立连接、发送 RPC、接收 snapshot/event。

```ts
export interface MultiplexerRemoteClient {
  readonly ready: boolean;

  connect(): Promise<void>;

  call<M extends ControlRpcMethod>(
    method: M,
    params: ControlRpcParams[M],
  ): Promise<ControlRpcResult[M]>;

  subscribe(listener: (event: ControlEvent) => void): () => void;
  reconnect(): Promise<void>;
  close(): Promise<void>;

  // internal: control socket 和 RPC pending 状态，落地实现时使用 private。
  readonly daemonManager: MultiplexerDaemonManager;
  readonly controlSocket?: WebSocket;
  readonly pendingRpc: Map<number, PendingRpc>;

  handleSnapshot(snapshot: Snapshot): void;
  handleHostEvent(event: ControlEvent): void;
  rejectPending(error: Error): void;
}
```

### MultiplexerDaemonManager

`MultiplexerDaemonManager` 负责 daemon 拉起、进程级恢复和低版本 daemon 强制替换，不直接解析业务 RPC。版本替换判断来自 `MultiplexerDiscovery` 的仲裁结果；Manager 只负责执行抢锁、停旧 daemon、拉新 daemon 和等待 ready。

```ts
export interface MultiplexerDaemonManager {
  ensureDaemon(): Promise<MultiplexerDiscoveryInfo>;
  spawnDaemon(): Promise<void>;
  waitUntilReady(timeout: number): Promise<MultiplexerDiscoveryInfo>;
  cleanupStaleDaemon(): boolean;
  replaceOutdatedDaemon(
    info: MultiplexerDiscoveryInfo,
    reason: MultiplexerDaemonReplaceReason,
  ): Promise<void>;
  acquireSpawnLock(): boolean;
  releaseSpawnLock(): void;

  // internal: discovery 和 spawn lock 状态，落地实现时使用 private。
  readonly discovery: MultiplexerDiscovery;
  readonly spawnLock: FileLock;
  readonly startupTimeout: number;
  readonly staleTimeout: number;
  readonly localProtocolVersion: number;

  handleDiscoveryValidation(
    validation: MultiplexerDiscoveryValidation,
  ): Promise<MultiplexerDiscoveryInfo>;
  stopDaemonForReplacement(
    info: MultiplexerDiscoveryInfo,
    reason: MultiplexerDaemonReplaceReason,
  ): Promise<void>;
  requestDaemonYield(
    info: MultiplexerDiscoveryInfo,
    reason: MultiplexerDaemonReplaceReason,
  ): Promise<boolean>;
  forceStopDaemon(info: MultiplexerDiscoveryInfo): Promise<void>;
}

export type MultiplexerDaemonManagerOption = {
  discovery: MultiplexerDiscovery;
  spawnLockPath: string;
  daemonEntry: string;
  startupTimeout: number;
  staleTimeout: number;
  localProtocolVersion: number;
};
```

`ensureDaemon()` 的版本处理流程：

1. 调用 `MultiplexerDiscovery.validateDiscovery()`。
2. 当结果为 `usable` 时复用当前 daemon。这里包括 daemon 与 connector 同版本，以及 daemon 版本高于 connector 的情况。
3. 当结果为 `replace-required` 时抢占 `spawn.lock`，调用 `replaceOutdatedDaemon()` 停止旧 daemon 并拉起当前版本 daemon。
4. 当结果为 `unusable` 时执行 stale/invalid 清理后拉起新 daemon。
5. 旧 daemon 被替换后，所有旧 control/WebSocket 连接会断开；connector 侧依赖全局 reconnect 重新 discovery 并接入新 daemon。

`requestDaemonYield()` 属于 Manager 的进程管理动作，不应设计成接入方可见业务 RPC。它可以通过旧 daemon 已支持的本地信号、内部控制请求或 replacement marker 实现；如果旧 daemon 版本过低、不支持让位能力或请求超时，再调用 `forceStopDaemon()` 基于 pid、lock 和 discovery 清理完成强制替换。

### MultiplexerDiscovery

`MultiplexerDiscovery` 只读 discovery，不负责 spawn daemon。它负责校验 discovery 文件是否新鲜、字段是否完整，并基于 `protocolVersion` 输出版本仲裁结果。

```ts
export interface MultiplexerDiscovery {
  readDiscovery(): MultiplexerDiscoveryInfo | null;
  validateDiscovery(
    info: MultiplexerDiscoveryInfo | null,
  ): MultiplexerDiscoveryValidation;
  compareProtocolVersion(
    info: MultiplexerDiscoveryInfo,
  ): MultiplexerProtocolCompatibility;
  isFresh(info: MultiplexerDiscoveryInfo): boolean;
  getFreshDiscovery(): MultiplexerDiscoveryInfo | null;
  getReusableDiscovery(): MultiplexerDiscoveryInfo | null;

  // internal: discovery 文件和协议校验配置，落地实现时使用 private。
  readonly discoveryPath: string;
  readonly localProtocolVersion: number;
  readonly staleTimeout: number;
}

export type MultiplexerDiscoveryInfo = {
  pid: number;
  protocolVersion: number;
  controlPort: number;
  token: string;
  heartbeat: number;
  startedAt?: number;
  daemonVersion?: string;
  capabilities?: string[];
};

export type MultiplexerDiscoveryOption = {
  discoveryPath: string;
  localProtocolVersion: number;
  staleTimeout: number;
};

export type MultiplexerProtocolCompatibility =
  | {
      status: "compatible";
      reason: "same-version" | "daemon-newer-compatible";
      daemonProtocolVersion: number;
      connectorProtocolVersion: number;
    }
  | {
      status: "replace-required";
      reason: "daemon-older-than-connector";
      daemonProtocolVersion: number;
      connectorProtocolVersion: number;
    };

export type MultiplexerDiscoveryValidation =
  | {
      status: "usable";
      info: MultiplexerDiscoveryInfo;
      compatibility: Extract<
        MultiplexerProtocolCompatibility,
        { status: "compatible" }
      >;
    }
  | {
      status: "replace-required";
      info: MultiplexerDiscoveryInfo;
      compatibility: Extract<
        MultiplexerProtocolCompatibility,
        { status: "replace-required" }
      >;
    }
  | {
      status: "unusable";
      reason:
        | "missing"
        | "invalid-json"
        | "invalid-shape"
        | "stale"
        | "missing-protocol-version";
      info?: MultiplexerDiscoveryInfo;
    };

export type MultiplexerDaemonReplaceReason =
  | "daemon-protocol-older-than-connector"
  | "stale-daemon"
  | "invalid-discovery";

```

版本仲裁规则：

- `info.protocolVersion === localProtocolVersion`：`usable/same-version`。
- `info.protocolVersion > localProtocolVersion`：`usable/daemon-newer-compatible`，connector 只使用自身已知的 RPC 和事件字段。
- `info.protocolVersion < localProtocolVersion`：`replace-required/daemon-older-than-connector`，由 `MultiplexerDaemonManager` 强制替换。
- discovery 缺失、格式错误、无 `protocolVersion` 或 heartbeat 过期：`unusable`。

### LegacyMultiOpenGuard

`LegacyMultiOpenGuard` 只在 Multiplexer 关闭时启用，用于保留原 `LatestDriverProcess` 多开抢占行为。

```ts
export interface LegacyMultiOpenGuard {
  setMultiOpenCallback(callback: MultiOpenCallback): void;
  prepareDriverDataDir(): void;
  startMonitorMultiOpen(): void;
  monitorLatestDriverProcessFile(): void;
  stop(): void;

  // internal: 旧多开状态，落地实现时使用 private。
  readonly multiOpenCallback: MultiOpenCallback;
  readonly monitoring: boolean;
  readonly multiOpenMonitorTimer?: NodeJS.Timeout;
  readonly currentStatus: MultiOpenStatus;

  updateLatestProcess(): void;
  monitorLatestDriverProcessFileSafely(): void;
}
```

## 3. Daemon 生命周期 API

### MultiplexerDaemon

`MultiplexerDaemon` 是 detached daemon 进程入口，负责持有 daemon lock、写入 discovery、刷新 heartbeat，并管理 Host 生命周期。

```ts
export interface MultiplexerDaemon {
  readonly discoveryInfo: MultiplexerDiscoveryInfo | null;

  start(option: MultiplexerDaemonOption): Promise<void>;
  stop(): Promise<void>;

  writeDiscovery(): void;
  refreshHeartbeat(): void;
  removeDiscovery(): void;

  holdDaemonLock(): void;
  releaseDaemonLock(): void;

  // internal: daemon 进程生命周期状态，落地实现时使用 private。
  readonly daemonLock: FileLock;
  readonly host: MultiplexerHost;
  readonly heartbeatTimer?: NodeJS.Timeout;
  readonly token: string;
  readonly controlPort: number;

  createDiscoveryInfo(): MultiplexerDiscoveryInfo;
  startHeartbeatTimer(): void;
  stopHeartbeatTimer(): void;
}

export type MultiplexerDaemonOption = {
  protocolVersion: number;
  daemonVersion?: string;
  capabilities?: string[];
  discoveryPath: string;
  daemonLockPath: string;
  controlPort?: number;
  token?: string;
  heartbeatInterval?: number;
  hostOption: MultiplexerHostOption;
};
```

## 4. Daemon 控制面 API

### MultiplexerHost

`MultiplexerHost` 负责 daemon 内控制面、路由、事件广播和 DTO 序列化。真实设备和 client 操作委托给包内共享的 `PhysicalConnector`。

```ts
export interface MultiplexerHost {
  start(): Promise<void>;
  stop(): Promise<void>;
  startWSServer(): Promise<void>;

  handleControlRpc<M extends ControlRpcMethod>(
    method: M,
    params: ControlRpcParams[M],
    controlId: number,
  ): Promise<ControlRpcResult[M]>;

  handleWebSocketMessage(
    webClientId: number,
    targetClientId: number,
    message: string,
  ): void;

  handlePhysicalMessage(clientId: number, message: string): void;

  sendMessageToWeb(message: string): void;
  sendMessageToWebClient(webClientId: number, message: string): void;
  sendMessageToApp(
    id: number,
    message: string,
    fromWebClientId?: number,
  ): void;

  createClientId(): number;
  broadcast(event: ControlEvent): void;

  // internal: daemon 控制面组合对象和路由状态，落地实现时使用 private。
  readonly reportService: DriverReportService | null;
  readonly physicalConnector: PhysicalConnector;
  readonly controlServer: MultiplexerControlServer;
  readonly webSocketController?: WebSocketController;
  readonly pendingRoutes: PendingRouteTable;
  readonly traceRecorder: ConnectionTraceRecorder | null;
  readonly wssPort: number;
  readonly wssHost?: string;
  readonly roomId?: string;
  readonly nextGlobalMessageId: number;
  readonly nextClientId: number;

  rewriteOutboundMessage(
    message: string,
    target: PendingTargetSeed,
  ): string;
  restoreInboundMessage(message: string): RoutedMessage | null;
  publishSnapshot(): void;
  publishPhysicalEvent(event: PhysicalConnectorEvent): void;
  serializeDevices(devices: BaseDevice[]): DeviceSnapshot[];
  serializeClients(clients: UsbClient[]): ClientSnapshot[];
}

export type MultiplexerHostOption = {
  reportService?: DriverReportService | null;
  physicalConnectorOption: PhysicalConnectorOption;
  websocketOption?: {
    port?: number;
    roomId?: string;
  };
  connectionTrace?: ConnectionTraceOptions;
};

export type PendingTargetSeed =
  | {
      kind: "control";
      controlId: number;
    }
  | {
      kind: "websocket";
      webClientId: number;
    };

export type RoutedMessage = {
  target: PendingTarget;
  clientId: number;
  message: string;
};
```

### MultiplexerControlServer

`MultiplexerControlServer` 管理 health endpoint、control WebSocket、token 校验、RPC 分发和事件广播。

```ts
export interface MultiplexerControlServer {
  readonly controlPort: number;
  readonly healthPath: "/health";
  readonly controlPath: "/debug-router-multiplexer/control";
  readonly connections: Map<number, MultiplexerControlConnection>;

  start(port: number, token: string): Promise<void>;
  stop(): Promise<void>;

  handleHealth(request: HttpRequest, response: HttpResponse): void;
  handleUpgrade(request: HttpRequest, socket: WebSocket): void;
  validateToken(request: HttpRequest): boolean;

  registerConnection(socket: WebSocket): MultiplexerControlConnection;
  unregisterConnection(controlId: number): void;

  dispatchRpc(controlId: number, message: ControlRpcRequest): Promise<void>;
  broadcast(event: ControlEvent): void;
  sendToControl(controlId: number, event: ControlEvent): void;

  // internal: control server 运行态，落地实现时使用 private。
  readonly host: MultiplexerHost;
  readonly token: string;
}

export type MultiplexerControlServerOption = {
  host: MultiplexerHost;
  token: string;
  controlPort: number;
  healthPath?: "/health";
  controlPath?: "/debug-router-multiplexer/control";
};
```

### MultiplexerControlConnection

`MultiplexerControlConnection` 表达单条 connector client 的 control WebSocket。

```ts
export interface MultiplexerControlConnection {
  readonly controlId: number;
  readonly subscribed: boolean;
  readonly closed: boolean;
  readonly pendingRpc: Map<number, PendingRpc>;

  send(event: ControlEvent | ControlRpcResponse): void;
  sendResponse(rpcId: number, result: unknown): void;
  sendError(rpcId: number, error: ControlRpcError): void;

  handleMessage(message: ControlRpcRequest): void;
  subscribe(): void;
  unsubscribe(): void;
  close(): void;

  // internal: 单条 control WebSocket 连接对象，落地实现时使用 private。
  readonly socket: WebSocket;

  rejectPending(error: Error): void;
  handleClose(): void;
}

export type MultiplexerControlConnectionOption = {
  controlId: number;
  socket: WebSocket;
  onMessage: (controlId: number, message: ControlRpcRequest) => void;
  onClose: (controlId: number) => void;
};
```

## 5. 物理连接 API

### PhysicalConnector

`PhysicalConnector` 是包内共享的真实连接层，唯一持有真实设备和真实 runtime client。mux daemon 通过 `MultiplexerHost` 组合它；mux disabled 的 legacy fallback 可以由 `DebugRouterConnector` 组合它。`PhysicalConnector` 不直接发出 connector 兼容事件，也不直接处理 control RPC，调用方负责把 `PhysicalConnectorEvent` 转换成旧事件或 `ControlEvent`。

```ts
export interface PhysicalConnector {
  readonly devices: Map<string, BaseDevice>;
  readonly usbClients: Map<number, UsbClient>;

  connectDevices(
    timeout?: number,
    serial?: string | null,
    isAutoListenClients?: boolean,
  ): Promise<BaseDevice[]>;

  getDevices(timeout?: number, serial?: string | null): Promise<BaseDevice[]>;

  connectUsbClients(
    deviceId: string,
    timeout?: number,
    waitTimeout?: boolean,
    clientName?: string | null,
  ): Promise<UsbClient[]>;

  startWatchAllClients(force?: boolean): void;
  addDeviceManager(manager: DeviceManager): void;

  registerDevice(device: BaseDevice): void;
  unregisterDevice(serial: string): void;
  regiserUsbClient(client: UsbClient): void;
  unregiserUsbClient(id: number): void;

  getAllUsbClients(): UsbClient[];
  getDeviceUsbClients(
    deviceId: string,
    timeout?: number,
    clientName?: string | null,
  ): Promise<UsbClient[]>;

  getAllPhysicalClients(): UsbClient[];

  sendMessage(clientId: number, message: unknown): void;
  sendRawMessage(
    clientId: number,
    message: RequireMessageType,
  ): Promise<ResponseMessageType>;

  closeClient(clientId: number): void;
  getAllAppClients(): Client[];
  disableAllClients(): void;

  on(event: string, callback: EventHandler): void;
  off(event: string, callback: EventHandler): void;

  // internal: 真实连接配置、设备管理器和查询工具，落地实现时使用 private/protected。
  readonly reportService: DriverReportService | null;
  readonly deviceManagers: Set<DeviceManager>;
  readonly traceRecorder: ConnectionTraceRecorder | null;
  readonly manualConnect?: boolean;
  readonly enableAndroid: boolean;
  readonly enableIOS: boolean;
  readonly enableHarmony: boolean;
  readonly enableDesktop: boolean;
  readonly enableNetworkDevice: boolean;
  readonly networkDeviceOpt?: {
    ip: string;
    port: number[];
  };
  readonly adbOption?: {
    host?: string;
    port?: number;
  };
  readonly hdcOption?: {
    host?: string;
    port?: number;
  };
  readonly usbConnectOpt: {
    retryTime: number;
  };

  startDeviceListeners(): Promise<void>;
  findDevice(serial: string | null): BaseDevice[];
  findUsbClient(clientName: string | null, clients: UsbClient[]): UsbClient[];
  isTargetClient(client: UsbClient, clientName: string | null): boolean;
  waitDeviceUsbCliens(
    deviceId: string,
    timeout?: number,
  ): Promise<UsbClient[]>;
  setOptionByEnv(): void;
}

export type PhysicalConnectorEvent =
  | {
      event: "device-connected";
      device: BaseDevice;
    }
  | {
      event: "device-disconnected";
      device: BaseDevice;
    }
  | {
      event: "client-connected";
      client: UsbClient;
    }
  | {
      event: "client-disconnected";
      id: number;
      client?: UsbClient;
    }
  | {
      event: "usb-client-message";
      id: number;
      message: string;
    };

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
    port: number[];
  };
  reportService?: DriverReportService | null;
  connectionTrace?: ConnectionTraceOptions;
};
```

## 6. 协议 DTO

协议 DTO 必须遵守以下兼容约束：

- 允许新增可选字段，例如 `meta?: ControlMessageMeta`、`capabilities?: string[]`。
- 允许新增 RPC method 或 ControlEvent event，但旧 connector 不应被要求调用或理解新 method/event。
- 禁止删除已有字段，禁止改变已有字段类型或语义。
- 禁止把已有可选字段改成必填字段。
- 高版本 daemon 处理低版本 connector 请求时，必须忽略未知字段并按旧字段语义返回。
- 高版本 connector 在发现低版本 daemon 时，不应继续调用新 RPC；应先由 `MultiplexerDaemonManager` 替换 daemon。

### ControlRpcRequest / ControlRpcResponse

```ts
export type ControlMessageMeta = {
  protocolVersion?: number;
  clientVersion?: string;
  daemonVersion?: string;
  capabilities?: string[];
};

export type ControlRpcRequest<M extends ControlRpcMethod = ControlRpcMethod> = {
  kind: "rpc";
  id: number;
  method: M;
  params: ControlRpcParams[M];
  meta?: ControlMessageMeta;
};

export type ControlRpcResponse<M extends ControlRpcMethod = ControlRpcMethod> =
  | {
      kind: "rpc-response";
      id: number;
      ok: true;
      result: ControlRpcResult[M];
      meta?: ControlMessageMeta;
    }
  | {
      kind: "rpc-response";
      id: number;
      ok: false;
      error: ControlRpcError;
      meta?: ControlMessageMeta;
    };

export type ControlRpcError = {
  code: string;
  message: string;
  details?: unknown;
};

export type ControlRpcMethod =
  | "connectDevices"
  | "getDevices"
  | "connectUsbClients"
  | "startWSServer"
  | "startWatchAllClients"
  | "sendMessageToWeb"
  | "sendMessageToApp"
  | "sendCustomizedMessage"
  | "sendRawMessage"
  | "sendMessage"
  | "closeClient";

export type ControlRpcParams = {
  connectDevices: {
    timeout?: number;
    serial?: string | null;
    isAutoListenClients?: boolean;
  };
  getDevices: {
    timeout?: number;
    serial?: string | null;
  };
  connectUsbClients: {
    deviceId: string;
    timeout?: number;
    waitTimeout?: boolean;
    clientName?: string | null;
  };
  startWSServer: {};
  startWatchAllClients: {
    force?: boolean;
  };
  sendMessageToWeb: {
    message: string;
  };
  sendMessageToApp: {
    id: number;
    message: string;
    fromWebClientId?: number;
  };
  sendCustomizedMessage: {
    clientId: number;
    method: string;
    params?: Object | string;
    sessionId?: number;
    type?: string;
  };
  sendRawMessage: {
    clientId: number;
    message: RequireMessageType;
  };
  sendMessage: {
    clientId: number;
    message: unknown;
  };
  closeClient: {
    clientId: number;
  };
};

export type ControlRpcResult = {
  connectDevices: DeviceSnapshot[];
  getDevices: DeviceSnapshot[];
  connectUsbClients: ClientSnapshot[];
  startWSServer: void;
  startWatchAllClients: void;
  sendMessageToWeb: void;
  sendMessageToApp: void;
  sendCustomizedMessage: string;
  sendRawMessage: ResponseMessageType;
  sendMessage: void;
  closeClient: void;
};
```

### ControlEvent

```ts
export type ControlEventEnvelope<Event extends string, Data> = {
  kind: "event";
  event: Event;
  data: Data;
  meta?: ControlMessageMeta;
};

export type ControlEvent =
  | ControlEventEnvelope<"snapshot", Snapshot>
  | ControlEventEnvelope<"device-connected", DeviceSnapshot>
  | ControlEventEnvelope<
      "device-disconnected",
      {
        serial: string;
      }
    >
  | ControlEventEnvelope<"client-connected", ClientSnapshot>
  | ControlEventEnvelope<
      "client-disconnected",
      {
        id: number;
      }
    >
  | ControlEventEnvelope<
      "usb-client-message",
      {
        id: number;
        message: string;
      }
    >
  | ControlEventEnvelope<
      "ws-client-message",
      {
        id: number;
        message: string;
      }
    >
  | ControlEventEnvelope<
      "ws-web-message",
      {
        id: number;
        message: string;
      }
    >
  | ControlEventEnvelope<
      "websocket-app-client-connected",
      WebSocketClientSnapshot
    >
  | ControlEventEnvelope<
      "websocket-app-client-disconnected",
      {
        id: number;
      }
    >
  | ControlEventEnvelope<
      "websocket-web-client-connected",
      WebSocketClientSnapshot
    >
  | ControlEventEnvelope<
      "websocket-web-client-disconnected",
      {
        id: number;
      }
    >;
```

### Snapshot / DeviceSnapshot / ClientSnapshot

```ts
export type Snapshot = {
  protocolVersion: number;
  generatedAt: number;
  devices: DeviceSnapshot[];
  clients: ClientSnapshot[];
  daemonVersion?: string;
  capabilities?: string[];
};

export type DeviceSnapshot = {
  info: DeviceDescription;
  serial: string;
  os: string;
  title: string;
  ports?: number[];
  host?: string;
};

export type ClientSnapshot = {
  info: ClientDescription;
  id: number;
  deviceId: string;
  app: string;
  os: string;
  sdkVersion?: string;
  raw_info?: unknown;
};

export type WebSocketClientSnapshot = {
  id: number;
  app: string;
  debugRouterVersion: string;
  deviceModel: string;
  network: "WiFi";
  osVersion: string;
  sdkVersion: string;
  type: string;
  raw_info: unknown;
};

export type MultiplexerHealthResponse = {
  ok: true;
  pid: number;
  protocolVersion: number;
  heartbeat: number;
  daemonVersion?: string;
  capabilities?: string[];
};
```

### PendingTarget / PendingRpc

```ts
export interface PendingRouteTable {
  readonly routes: Map<number, PendingTarget>;

  addControlRoute(
    globalId: number,
    controlId: number,
    originalId: number,
    resolve: (value: unknown) => void,
    reject: (error: Error) => void,
    timer: NodeJS.Timeout,
  ): void;

  addWebSocketRoute(
    globalId: number,
    webClientId: number,
    originalId: number,
  ): void;

  take(globalId: number): PendingTarget | undefined;
  remove(globalId: number): void;
  clearByControlId(controlId: number): void;
}

export type PendingTarget =
  | {
      kind: "control";
      controlId: number;
      originalId: number;
      clientId: number;
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      timer: NodeJS.Timeout;
      createdAt: number;
    }
  | {
      kind: "websocket";
      webClientId: number;
      originalId: number;
      clientId: number;
      createdAt: number;
    };

export type PendingRpc = {
  id: number;
  method: string;
  createdAt: number;
  timeoutMs: number;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};
```

### 基础占位类型

```ts
export type HttpRequest = unknown;
export type HttpResponse = unknown;
export type WebSocket = unknown;
export type FileLock = unknown;
export type WebSocketController = unknown;
```
