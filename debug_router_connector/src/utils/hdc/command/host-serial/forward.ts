import Command from "../../command";

export default class ForwardCommand extends Command<boolean> {
  public execute(local: string, remote: string): Promise<boolean> {
    const command = `fport ${local} ${remote}`;
    const data = Buffer.from(command, "ascii");
    this.send(data);
    return this.connection.parser.readValue().then(this._parseResult);
  }

  private _parseResult(value: Buffer): boolean {
    const message = value.toString("ascii");
    if (message.includes("Forwardport result:OK")) {
      return true;
    } else {
      return false;
    }
  }
}
