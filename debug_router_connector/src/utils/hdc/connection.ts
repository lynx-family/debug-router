import { EventEmitter } from "events";
import { ClientOptions } from "./ClientOptions";
import { Socket } from "net";
import * as Net from "net";
import Parser from "./parser";
import { getDriverReportService } from "../../report/interface/DriverReportService";

interface HandShake {
  banner: string;
  connectKey: string;
  version?: string;
}

const HandShakeBannerSize = 12;
const HandShakeConnectKeySize = 32;

export default class Connection extends EventEmitter {
  public options: ClientOptions;
  public socket!: Socket;
  public parser!: Parser;
  public handshakeOK: boolean;

  constructor(options?: ClientOptions) {
    super();
    this.options = options || { port: 0 };
    this.handshakeOK = false;
  }

  public connect(connectKey: string = ""): Promise<Connection> {
    this.socket = Net.connect(this.options);
    this.socket.setNoDelay(true);
    this.parser = new Parser(this.socket);
    this.socket.on("connect", () => this.emit("connect"));
    this.socket.on("end", () => this.emit("end"));
    this.socket.on("drain", () => this.emit("drain"));
    this.socket.on("timeout", () => this.emit("timeout"));
    this.socket.on("close", (hadError: boolean) =>
      this.emit("close", hadError),
    );
    return new Promise<Connection>(async (resolve, reject) => {
      try {
        const length = await this.parser.readLength();
        if (length < HandShakeBannerSize + HandShakeConnectKeySize) {
          getDriverReportService()?.report("hdc_connect_error", null, {
            msg: "connect failed for HandShake Length Error",
          });
          reject(new Error("HandShake Length Error"));
        }
        const data = await this.parser.readBytes(length);
        const banner = data
          .subarray(0, HandShakeBannerSize - 1)
          .toString("ascii");
        if (banner.localeCompare("OHOS HDC")) {
          getDriverReportService()?.report("hdc_connect_error", null, {
            msg: "connect failed for HandShake Banner Error",
          });
          reject(new Error("HandShake Banner Error"));
        }
        const chnnelId = data.readUInt32BE(HandShakeBannerSize - 1);
        const response = Buffer.alloc(48);
        response.writeInt32BE(HandShakeBannerSize + HandShakeConnectKeySize);
        response.write(banner, 4, "ascii");
        if (connectKey && connectKey.length <= HandShakeConnectKeySize) {
          response.write(connectKey, 4 + HandShakeBannerSize, "ascii");
        }
        this.write(response, (error) => {
          if (error) {
            console.log("error:", error.message);
            getDriverReportService()?.report("hdc_connect_error", null, {
              msg: "connect failed for write response error",
            });
            reject(error);
          } else {
            this.handshakeOK = true;
            resolve(this);
          }
        });
      } catch (err) {
        getDriverReportService()?.report("hdc_connect_error", null, {
          msg: "connect failed for catch other error",
        });
        reject(err);
      }
    });
  }

  public write(data: Buffer, callback?: (err?: Error) => void): this {
    this.socket.write(data, callback);
    return this;
  }

  public async kill(): Promise<void> {
    if (this.socket) {
      this.socket.destroy();
    }
  }
}
