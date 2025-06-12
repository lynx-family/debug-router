import Forward from "../../Forward";
import Command from "../../command";

export default class ListForwardCommand extends Command<Forward[]> {
  public execute(...args: any[]): Promise<Forward[]> {
    const command = `fport ls`;
    const data = Buffer.from(command, "ascii");
    this.send(data);
    return this.connection.parser.readValue().then(this._parseResult);
  }

  private _parseResult(value: Buffer): Forward[] {
    return value
      .toString("ascii")
      .split("\n")
      .filter((e) => e)
      .map((line) => {
        if (line.startsWith("[Fail]")) {
          throw new Error(line);
        }
        const fLine = line.split("\t");
        let taskInfo;
        let connectKey = "";
        if (fLine.length > 2) {
          taskInfo = fLine[1];
          connectKey = fLine[0];
        } else {
          taskInfo = fLine[0];
        }
        taskInfo = taskInfo.replace("'", "");
        let [local, remote] = taskInfo.split(" ");
        return {
          connectKey,
          local,
          remote,
        };
      });
  }
}
