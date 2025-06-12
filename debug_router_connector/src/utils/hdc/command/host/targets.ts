import Target from "../../Target";
import Command from "../../command";
import Connection from "../../connection";

export default class TargetsCommand extends Command<Target[]> {
  constructor(connection: Connection) {
    super(connection);
  }

  public execute(...args: any[]): Promise<Target[]> {
    const command = "list targets -v";
    const data = Buffer.from(command, "ascii");
    this.send(data);
    return this.connection.parser.readValue().then(this._parseDevices);
  }

  public _parseDevices(value: Buffer): Target[] {
    return value
      .toString("ascii")
      .split("\n")
      .filter((e) => e && !e.startsWith("[Empty]"))
      .map((line) => {
        if (line.startsWith("[Fail]")) {
          throw new Error(line);
        }
        const [
          connKey,
          _,
          connType = "TCP",
          connStatus = "UNKONW",
          devName,
        ] = line.split("\t");
        return {
          connectKey: connKey,
          connType: connType as "TCP" | "USB" | "UART" | "BT" | "UNKNOW",
          connStatus: connStatus as
            | "Ready"
            | "Connected"
            | "Offline"
            | "UNKNOW",
          devName,
        };
      });
  }
}
