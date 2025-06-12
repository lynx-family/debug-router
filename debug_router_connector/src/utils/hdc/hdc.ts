import { ClientOptions } from "./ClientOptions";
import Client from "./client";

interface Options {
  host?: string;
  port?: number;
  bin?: string;
  timeout?: number;
}

export default class Hdc {
  public static createClient(options: Options = {}) {
    const opts: ClientOptions = {
      bin: options.bin,
      host: options.host || "127.0.0.1",
      port: options.port || 8710,
      timeout: options.timeout || 0,
    };

    if (!options.port) {
      const port = parseInt(process.env.ENV_SERVER_PORT || "8710");
      if (!isNaN(port)) {
        opts.port = port;
      }
    }

    return new Client(opts);
  }
}
