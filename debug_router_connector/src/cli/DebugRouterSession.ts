import { DebugRouterConnector, devOption } from "../connector/DebugRouterConnector";
import { MultiOpenStatus } from "../connector/MultiOpenCallBack";
import { UsbClient } from "../usb/Client";
import { CDPEventHandler } from "../utils/type";
import { CliError, CliPlatform, ListOutput } from "./types";

export type ConnectorLike = Pick<
  DebugRouterConnector,
  | "setMultiOpenCallback"
  | "connectDevices"
  | "connectUsbClients"
  | "on"
  | "off"
  | "close"
>;

export type ConnectorFactory = (options: devOption) => ConnectorLike;

export function makeClientId(deviceId: string, port: number): string {
  return `${encodeURIComponent(deviceId)}:${port}`;
}

export class DebugRouterSession {
  private connector?: ConnectorLike;
  private clients: UsbClient[] = [];
  private closed = false;
  private preemptReject!: (error: Error) => void;
  private readonly preempted = new Promise<never>((_, reject) => {
    this.preemptReject = reject;
  });
  private hasBeenPreempted = false;
  private activeListenResolve?: () => void;
  private activeListenReject?: (error: Error) => void;
  private activeListenCleanup?: () => void;

  constructor(
    private readonly connectorFactory: ConnectorFactory = (options) =>
      new DebugRouterConnector(options),
  ) {}

  async open(
    platforms: CliPlatform[] = [],
    allowOwnershipTakeover = false,
  ): Promise<void> {
    const selected = new Set(platforms);
    const explicit = platforms.length > 0;
    this.connector = this.connectorFactory({
      manualConnect: true,
      enableWebSocket: false,
      enableAndroid: explicit ? selected.has("android") : true,
      enableIOS: explicit ? selected.has("ios") : true,
      enableHarmony: explicit ? selected.has("harmony") : true,
      enableDesktop: explicit ? selected.has("desktop") : false,
      enableNetworkDevice: false,
      reportService: null,
      allowOwnershipTakeover,
    });
    this.connector.setMultiOpenCallback({
      statusChanged: (status) => {
        if (status === MultiOpenStatus.unattached && !this.hasBeenPreempted) {
          this.hasBeenPreempted = true;
          this.preemptReject(
            new CliError(
              "CONNECTOR_PREEMPTED",
              "DebugRouterConnector was preempted by another process",
            ),
          );
        }
      },
    });
  }

  async discover(timeoutMs: number): Promise<ListOutput> {
    const connector = this.requireConnector();
    const devices = await this.race(connector.connectDevices(timeoutMs));
    const clientGroups = await this.race(
      Promise.all(
        devices.map((device) =>
          connector.connectUsbClients(device.info.serial, timeoutMs, true),
        ),
      ),
    );
    this.clients = clientGroups.flat();

    return {
      devices: devices
        .map((device) => ({
          id: device.info.serial,
          platform: device.info.os,
          name: device.info.title,
        }))
        .sort((a, b) => a.id.localeCompare(b.id)),
      clients: this.clients
        .map((client) => ({
          id: makeClientId(client.deviceId(), client.info.port),
          deviceId: client.deviceId(),
          platform: client.info.query.os,
          port: client.info.port,
          app: client.info.query.app,
          sdkVersion: client.info.query.sdk_version ?? "",
        }))
        .sort(
          (a, b) =>
            a.deviceId.localeCompare(b.deviceId) || a.port - b.port,
        ),
    };
  }

  resolveTarget(selectors: {
    deviceId?: string;
    clientId?: string;
  }): UsbClient {
    const candidates = this.clients.filter((client) => {
      const clientId = makeClientId(client.deviceId(), client.info.port);
      return (
        (!selectors.deviceId || client.deviceId() === selectors.deviceId) &&
        (!selectors.clientId || clientId === selectors.clientId)
      );
    });
    if (candidates.length === 0) {
      throw new CliError("TARGET_NOT_FOUND", "No client matched the selectors");
    }
    if (candidates.length > 1) {
      throw new CliError("TARGET_AMBIGUOUS", "Multiple clients matched", {
        candidates: candidates
          .map((client) => makeClientId(client.deviceId(), client.info.port))
          .sort(),
      });
    }
    return candidates[0];
  }

  async send(
    client: UsbClient,
    method: string,
    params: object,
    sessionId: number,
    type: "CDP" | "App",
    timeoutMs: number,
  ): Promise<unknown> {
    const response = await this.race(
      client.sendCustomizedMessage(method, params, sessionId, type, timeoutMs),
    );
    try {
      return JSON.parse(response);
    } catch {
      throw new CliError("MALFORMED_PROTOCOL_RESPONSE", "Response is not JSON");
    }
  }

  async listen(
    client: UsbClient,
    onEvent: CDPEventHandler,
    timeoutMs?: number,
  ): Promise<void> {
    const connector = this.requireConnector();
    client.onAllEvents(onEvent);
    const disconnect = (id: number) => {
      if (id === client.clientId()) {
        this.activeListenReject?.(
          new CliError("TARGET_DISCONNECTED", "Target client disconnected"),
        );
      }
    };
    connector.on("client-disconnected", disconnect);
    let timer: NodeJS.Timeout | undefined;
    const completion = new Promise<void>((resolve, reject) => {
      this.activeListenResolve = resolve;
      this.activeListenReject = reject;
      if (timeoutMs) {
        timer = setTimeout(resolve, timeoutMs);
      }
    });
    this.activeListenCleanup = () => {
      if (timer) {
        clearTimeout(timer);
      }
      connector.off("client-disconnected", disconnect);
      client.offAllEvents(onEvent);
      this.activeListenResolve = undefined;
      this.activeListenReject = undefined;
      this.activeListenCleanup = undefined;
    };
    try {
      await this.race(completion);
    } finally {
      this.activeListenCleanup?.();
    }
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.activeListenResolve?.();
    this.activeListenCleanup?.();
    await this.connector?.close();
  }

  private race<T>(operation: Promise<T>): Promise<T> {
    return Promise.race([operation, this.preempted]);
  }

  private requireConnector(): ConnectorLike {
    if (!this.connector) {
      throw new Error("Session is not open");
    }
    return this.connector;
  }
}
