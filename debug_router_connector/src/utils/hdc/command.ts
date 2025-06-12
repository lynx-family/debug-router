import Connection from "./connection";
import Parser from "./parser";

export default abstract class Command<T> {
  public connection: Connection;
  public parser: Parser;
  constructor(connection: Connection) {
    this.connection = connection;
    this.parser = this.connection.parser;
  }

  public abstract execute(...args: any[]): Promise<T>;

  public send(data: Buffer): Command<T> {
    const encoded = this.encodeData(data);
    this.connection.write(encoded);
    return this;
  }

  private encodeData(data: Buffer): Buffer {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    return Buffer.concat([len, data]);
  }
}
