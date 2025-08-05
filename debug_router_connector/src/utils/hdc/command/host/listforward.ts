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
    // fport ls value format (example):
    // MJE0xxxxx    tcp:18501 tcp:8901    [Forward]
    // what we want is:
    // {
    //   connectKey: "MJE0xxxxx",
    //   local: "tcp:18501",
    //   remote: "tcp:8901",
    // }
    return value
      .toString("ascii")
      .split("\n")
      .filter((e) => e)
      .map((line) => {
        if (line.startsWith("[Fail]")) {
          throw new Error(line);
        }
        // split by space, and remove empty string
        const parts = line.trim().split(/\s+/).filter(Boolean);
        let taskInfo = "";
        let connectKey = "";

        if (
          parts.length >= 3 &&
          parts[1].includes(":") &&
          parts[2].includes(":")
        ) {
          connectKey = parts[0];
          taskInfo = `${parts[1]} ${parts[2]}`;
        } else if (parts.length >= 2 && parts[1].includes(":")) {
          connectKey = parts[0];
          taskInfo = parts[1];
        } else if (parts.length >= 1) {
          taskInfo = parts[0];
        }

        taskInfo = taskInfo.replace("'", "");
        const [local, remote = ""] = taskInfo.split(" ").filter(Boolean);
        return {
          connectKey,
          local,
          remote,
        };
      });
  }
}
