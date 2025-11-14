// Copyright 2024 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

import * as net from "net";
// @ts-ignore
import * as bufferpack from "bufferpack";
// @ts-ignore
import { getTunnel } from "../../third_party/usbmux/lib/usbmux";
import { packMessage } from "./utils";
import {
  CDPEventMessage,
  ClientQuery,
  CustomizedEventType,
  InitializeMessageType,
  isCustomizedEventType,
  isTypedSocketMessage,
  SocketEvent,
} from "../utils/type";
import { USBConnection } from "./USBConnection";
import { Connection } from "./Connection";
import { DebugRouterConnector } from "../connector";
import { defaultLogger } from "../utils/logger";
import { getDriverReportService } from "../report/interface/DriverReportService";

export interface ClientEventsListener {
  onConnectionCreated(
    connection: Connection,
    port: number,
    clientQuery: ClientQuery,
  ): number;

  onConnectionDeleted(id: number): void;
}

export default class ClientAdapter {
  private readonly initialBufferCapacity: number = 1024 * 1024 * 2;
  private readonly usbmuxdPacketHeaderLength: number = 20;
  private bufferCapacity: number = this.initialBufferCapacity;
  private buffer: Buffer | null = null;
  private offset: number = 0;
  private end: number = 0;
  protected tcpClient: net.Socket = new net.Socket();
  protected isConnected: boolean = false;
  protected connection: Connection | null = null;
  protected from?: number;
  protected id: number = 0;
  constructor(
    protected driver: DebugRouterConnector,
    protected listener: ClientEventsListener | null,
    protected readonly port: number,
    protected readonly device: string,
    protected readonly device_id: string,
    public readonly type: string,
    protected readonly device_host: string,
  ) {}

  protected handleData(client: net.Socket, data: Buffer) {
    try {
      this.handleUnpackMessage(data);
    } catch (error: any) {
      const msg = "pack data error:" + error?.message + " " + this.port;
      defaultLogger.debug(msg);
      getDriverReportService()?.report("handle_unpack_message_error", null, {
        msg: msg,
        type: "all_devices",
        stage: "handle_data",
      });
      client.end();
    }
  }

  protected handleOff(client: net.Socket) {
    this.isConnected = false;
    client.destroy();
    if (this.listener === null) {
      defaultLogger.debug("handleOff: this.listener == null");
      return;
    }
    this.listener.onConnectionDeleted(this.id);
  }

  protected handleUnpackMessage(data: any) {
    if (!data) {
      return;
    }
    // lazy alloc data
    if (this.buffer === null) {
      this.buffer = Buffer.allocUnsafe(this.initialBufferCapacity);
    }
    // no enough space for new message
    if (this.bufferCapacity - this.end < data.length) {
      if (this.bufferCapacity - (this.end - this.offset) >= data.length) {
        // there are enough space, just need to move the buffer
        this.buffer.copy(this.buffer, 0, this.offset, this.end);
      } else {
        // grow buffer capacity
        this.bufferCapacity *= 2;
        while (this.bufferCapacity < this.end - this.offset + data.length)
          this.bufferCapacity *= 2;
        const newBuffer = Buffer.allocUnsafe(this.bufferCapacity);
        this.buffer.copy(newBuffer, 0, this.offset, this.end);
        this.buffer = newBuffer;
      }
      this.end = this.end - this.offset;
      this.offset = 0;
    }

    data.copy(this.buffer, this.end);
    this.end += data.length;

    while (true) {
      const length = this.end - this.offset;
      if (length < this.usbmuxdPacketHeaderLength) {
        break;
      }

      const header = bufferpack.unpack("! I I I I I", this.buffer, this.offset);
      if (!header) {
        break;
      }

      const size = header[4];
      if (size + this.usbmuxdPacketHeaderLength <= length) {
        const receivedBuffer = this.buffer.toString(
          "utf8",
          this.offset + this.usbmuxdPacketHeaderLength,
          this.offset + this.usbmuxdPacketHeaderLength + size,
        );
        try {
          const parsedMessage = JSON.parse(receivedBuffer);
          if (Array.isArray(parsedMessage)) {
            for (const message of parsedMessage) {
              this.handleMessage(JSON.stringify(message));
            }
          } else if (parsedMessage?.type == 'batch') {
            parsedMessage.messages.forEach((message: any) => {
              this.handleMessage(JSON.stringify(message, null, 2));
            })
          } else {
            this.handleMessage(receivedBuffer);
          }
        } catch (error) {
          defaultLogger.debug("parse message error:" + error);
        }
        this.offset += this.usbmuxdPacketHeaderLength + size;
        if (this.offset == this.end) {
          this.offset = 0;
          this.end = 0;
        }
      } else {
        break;
      }
    }
  }

  onConnect(): void {
    const initialize: InitializeMessageType = {
      event: "Initialize",
      data: -1,
    };
    try {
      if (this.tcpClient.writable && !this.tcpClient.destroyed) {
        defaultLogger.debug("send Initialize:" + this.port);
        this.tcpClient.write(packMessage(initialize));
      }
    } catch (err) {
      defaultLogger.debug("send Initialize error:" + JSON.stringify(err));
    }
  }

  protected async handleMessage(message: string): Promise<void> {
    if (process.env.PrintAllUSBMessage === "enable") {
      defaultLogger.info("[Receive]:" + message);
    }
    //getDriverReportService()?.report("USBReceiveMessage", null, {type: "all_devices"});
    if (!this.isConnected) {
      await this.handleConnection(message);
      return;
    }
    this.driver.emit("usb-client-message", { id: this.id, message });
    if (this.driver.enableWebSocket) {
      this.driver.handleUsbMessage(this.id, message);
    }

    const response: any = JSON.parse(message);
    const data = response.data;
    let callback = null;
    if (isTypedSocketMessage(response, SocketEvent.Customized)) {
      if (
        !isCustomizedEventType(response, CustomizedEventType.CDP) &&
        !isCustomizedEventType(response, CustomizedEventType.App)
      ) {
        if (isCustomizedEventType(response, CustomizedEventType.SessionList)) {
          this.handleSessionList(data.data);
          return;
        }
        if (this.connection) {
          callback = this.connection.matchPendingRequest(data.type);
        }
      } else {
        const cdpMessage: any = JSON.parse(data.data.message);
        if (cdpMessage?.id && this.connection) {
          callback = this.connection.matchPendingRequest(
            cdpMessage.id.toString(),
          );
        } else if (cdpMessage?.method) {
          this.handleClientEvent(data.data.message, data.data?.session_id);
        }
      }
    }
    if (callback) {
      callback.resolve(response);
    }
  }

  private async handleConnection(message: string): Promise<void> {
    const response: any = JSON.parse(message);
    if (isTypedSocketMessage(response, SocketEvent.Register)) {
      getDriverReportService()?.report("register_msg", null, {
        msg: message,
        port: this.port,
      });
      const result = response.data?.info;
      const app = result["App"] ?? "Unknow";
      const sdk_version = result["sdkVersion"] ?? "0.0.0";
      let deviceModel = result["deviceModel"] ?? "";
      if (this.type === "Mac" && deviceModel === "iPhone") {
        deviceModel = deviceModel + "_FromMac";
      }
      const ClientQuery: ClientQuery = {
        app,
        os: this.type,
        device: this.device,
        device_model: deviceModel,
        device_id: this.device_id,
        sdk_version,
        raw_info: result,
      };
      if (this.listener === null) {
        defaultLogger.debug(
          "handleConnection: this.listener = null:" +
            JSON.stringify(ClientQuery),
        );
        return;
      }
      this.connection = new USBConnection(this.tcpClient);
      this.id = this.listener.onConnectionCreated(
        this.connection,
        this.port,
        ClientQuery,
      );
      this.isConnected = true;
    }
  }

  protected handleClientEvent(
    message: string,
    session_id: number | undefined,
  ): void {
    const response: CDPEventMessage = JSON.parse(message);
    if (response.method && this.connection) {
      this.connection.handleClientEvent(response.method, response.params, {
        session_id: session_id !== undefined ? session_id : -1,
      });
    }
  }

  protected handleSessionList(sessionList: any) {
    if (this.connection) {
      this.connection.handleSessionList(sessionList);
    }
  }

  connect(): void {
    if (this.isConnected || this.tcpClient.connecting) return;
    const platform = this.type;
    if (platform === "iOS") {
      getTunnel(this.port, { udid: this.device_id })
        .then((tunnel: net.Socket) => {
          this.tcpClient = tunnel;
          this.tcpClient.on("data", (data: Buffer) => {
            this.handleData(this.tcpClient, data);
          });
          this.tcpClient.on("close", () => {
            defaultLogger.debug("ios device close:" + this.port);
            this.handleOff(this.tcpClient);
          });

          this.tcpClient.on("usbmux_error", (err: Error) => {
            const msg = "ios device error:" + err?.message + " " + this.port;
            defaultLogger.debug(msg);
            getDriverReportService()?.report("ios_connect_error", null, {
              msg: msg,
              stage: "client",
            });
            this.handleOff(this.tcpClient);
          });
          this.onConnect();
        })
        .catch((err: Error) => {
          const msg =
            "ios connect error:" + this.port + " error:" + err?.message;
          defaultLogger.debug(msg);
          getDriverReportService()?.report("ios_connect_error", null, {
            msg: msg,
            stage: "client",
          });
        });
    } else {
      try {
        this.tcpClient = new net.Socket();
        this.tcpClient.on("data", (data: Buffer) => {
          this.handleData(this.tcpClient, data);
        });
        this.tcpClient.on("error", (err: Error) => {
          const msg =
            platform + " device error:" + err?.message + " " + this.port;
          defaultLogger.debug(msg);
          const error_title = platform + "_connect_error";
          getDriverReportService()?.report(error_title, null, {
            msg: msg,
            stage: "client",
          });
          this.handleOff(this.tcpClient);
        });

        this.tcpClient.on("close", (hadError: boolean) => {
          defaultLogger.debug(
            platform + " device close:" + this.port + " hadError:" + hadError,
          );
          this.handleOff(this.tcpClient);
        });
        this.tcpClient.on("connect", () => {
          defaultLogger.debug(platform + " device onConnect:" + this.port);
          this.onConnect();
        });
        const host = this.device_host;
        this.tcpClient.connect({ host: host, port: this.port });
      } catch (err: any) {
        const msg =
          platform + " connect error:" + this.port + " error:" + err?.message;
        defaultLogger.debug(msg);
        const error_title = platform + "_connect_error";
        getDriverReportService()?.report(error_title, null, {
          msg: msg,
          stage: "client",
        });
      }
    }
  }

  public destroy() {
    defaultLogger.debug("ClientAdapter destroy");
    this.listener = null;
    this.tcpClient.destroy();
    this.buffer = null;
    this.connection = null;
  }
}
