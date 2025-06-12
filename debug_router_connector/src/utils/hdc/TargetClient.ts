import { defaultLogger } from "../../utils/logger";
import Client from "./client";
import Forward from "./Forward";
import ForwardCommand from "./command/host-serial/forward";
import ListForwardCommand from "./command/host/listforward";
import RemoveForwardCommand from "./command/host/removeforward";
import Connection from "./connection";
import { getDriverReportService } from "../../report/interface/DriverReportService";

export default class TargetClient {
  constructor(
    public readonly client: Client,
    public readonly connKey: string,
  ) {}

  public forward(local: string, remote: string): Promise<boolean> {
    return this.connection(this.connKey)
      .then((conn) => new ForwardCommand(conn).execute(local, remote))
      .catch((e: Error) => {
        defaultLogger.debug(`Forward fail: ${e.message}`);

        getDriverReportService()?.report("hdc_forward_error", null, {
          msg: "target client forward failed",
          error: e?.message,
        });
        return false;
      });
  }

  public listForwards(): Promise<Forward[]> {
    return this.connection()
      .then((conn) => new ListForwardCommand(conn).execute())
      .catch((e: Error) => {
        defaultLogger.debug(`ListForwards fail: ${e.message}`);

        getDriverReportService()?.report("hdc_listforwards_error", null, {
          msg: "target client listForwards failed",
          error: e?.message,
        });
        return [];
      });
  }

  public removeForward(local: string, remote: string): Promise<boolean> {
    return this.connection()
      .then((conn) => new RemoveForwardCommand(conn).execute(local, remote))
      .catch((e: Error) => {
        defaultLogger.debug(`RemoveForward fail: ${e.message}`);

        getDriverReportService()?.report("hdc_removeforward_error", null, {
          msg: "target client removeForward failed",
          error: e?.message,
        });
        return false;
      });
  }

  private connection(connKey: string = ""): Promise<Connection> {
    return this.client.connection(connKey);
  }
}
