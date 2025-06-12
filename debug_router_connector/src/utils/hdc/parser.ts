import { Duplex } from "stream";

export default class Parser {
  private ended: boolean = false;
  constructor(public stream: Duplex) {}

  public end(): Promise<boolean> {
    return Promise.resolve(true);
  }

  public readAscii(howMany: number): Promise<string> {
    return this.readBytes(howMany).then((chunk) => {
      return chunk.toString("ascii");
    });
  }

  public readLength(): Promise<number> {
    return this.readBytes(4).then((chunk) => {
      return chunk.readUInt32BE();
    });
  }

  public readBytes(howMany: number): Promise<Buffer> {
    let tryRead: () => void;
    let errorListener: (error: Error) => void;
    let endListener: () => void;
    let timeoutListener: () => void;

    return new Promise<Buffer>((resolve, reject) => {
      tryRead = () => {
        if (howMany) {
          const chunk = this.stream.read(howMany);

          if (chunk) {
            howMany -= chunk.length;
            if (howMany === 0) {
              return resolve(chunk);
            }
          }

          if (this.ended) {
            reject(new Error("Premature end of stream"));
          }
        } else {
          resolve(Buffer.alloc(0));
        }
      };
      endListener = () => {
        this.ended = true;
        reject(new Error("Premature end of stream"));
      };
      timeoutListener = () => {
        this.stream.end();
        reject(new Error("Socket timeout reached."));
      };
      errorListener = (error: Error) => {
        this.stream.end();
        reject(error);
      };
      this.stream.on("readable", tryRead);
      this.stream.on("error", errorListener);
      this.stream.on("end", endListener);
      this.stream.on("timeout", timeoutListener);
      tryRead();
    }).finally(() => {
      this.stream.removeListener("readable", tryRead);
      this.stream.removeListener("error", errorListener);
      this.stream.removeListener("end", endListener);
      this.stream.removeListener("timeout", timeoutListener);
    });
  }

  public readValue(): Promise<Buffer> {
    return new Promise<Buffer>(async (resolve, reject) => {
      try {
        const length = await this.readLength();
        const result = await this.readBytes(length);
        resolve(result);
      } catch (err) {
        reject("7");
      }
    });
  }
}
