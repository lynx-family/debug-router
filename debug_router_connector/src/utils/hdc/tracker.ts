import { EventEmitter } from "events";
import Target from "./Target";
import Client from "./client";
import { getDriverReportService } from "../../report/interface/DriverReportService";

export default class Tracker extends EventEmitter {
  private targets: Target[] = [];
  private targetMap: Record<string, Target> = {};
  private closed = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  constructor(private readonly client: Client) {
    super();
    this.read();
  }

  public read() {
    if (this.closed) return;
    this.client
      .listTargets()
      .then((targets) => {
        if (this.closed) return;
        this.update(targets);
        if (this.closed) return;
        this.timer = setTimeout(() => {
          this.timer = undefined;
          this.read();
        }, 1000);
      })
      .catch((err) => {
        if (this.closed) return;
        this.emit("error", err);
        getDriverReportService()?.report("hdc_read_targets_error", null, {
          msg: "hdc tracker listTargets or updateTargets failed",
          error: err?.message,
        });
      });
  }

  public end(): void {
    this.closed = true;
    clearTimeout(this.timer);
    this.timer = undefined;
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
