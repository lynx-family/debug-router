import { EventEmitter } from "events";
import Target from "./Target";
import Client from "./client";
import { getDriverReportService } from "../../report/interface/DriverReportService";

export default class Tracker extends EventEmitter {
  private targets: Target[] = [];
  private targetMap: Record<string, Target> = {};
  constructor(private readonly client: Client) {
    super();
    this.read();
  }

  public read() {
    let queryFailed = false;
    this.client
      .listTargets((error) => {
        // Preserve the existing empty-list fallback for business logic, but do
        // not report it as a successful empty discovery result.
        queryFailed = true;
        this.emit("queryError", error);
      })
      .then((targets) => {
        if (!queryFailed) this.emit("snapshot", targets);
        this.update(targets);
        setTimeout(() => {
          this.read();
        }, 1000);
      })
      .catch((err) => {
        this.emit("error", err);
        getDriverReportService()?.report("hdc_read_targets_error", null, {
          msg: "hdc tracker listTargets or updateTargets failed",
          error: err?.message,
        });
      });
  }

  private update(newTragets: Target[]) {
    const newMap: Record<string, Target> = {};
    // keep different status
    const removed: Target[] = [];
    const changed: Target[] = [];
    const added: Target[] = [];

    newTragets.forEach((newTarget) => {
      const oldTarget = this.targetMap[newTarget.connectKey];
      // ignore when the connection status is unstable
      if (newTarget.devName === "unknown...") {
        return;
      }

      if (oldTarget) {
        if (oldTarget.connStatus !== newTarget.connStatus) {
          changed.push(newTarget);
          this.emit("change", newTarget, oldTarget);
        }
      } else {
        added.push(newTarget);
        this.emit("add", newTarget);
      }
      newMap[newTarget.connectKey] = newTarget;
    });

    this.targets.forEach((oldTarget) => {
      if (
        !newMap[oldTarget.connectKey] ||
        (newMap[oldTarget.connectKey].connStatus === "Offline" &&
          oldTarget.connStatus === "Connected")
      ) {
        removed.push(oldTarget);
        this.emit("remove", oldTarget);
      }
    });

    this.emit("deviceChangeSet", {
      added,
      removed,
      changed,
    });
    this.targets = newTragets;
    this.targetMap = newMap;
  }
}
