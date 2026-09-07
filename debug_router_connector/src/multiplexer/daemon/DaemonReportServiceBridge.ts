// Copyright 2026 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

import type { DriverReportService } from "../../report/interface/DriverReportService";
import type { ReportEventData } from "../protocol/event";
import { defaultLogger } from "../../utils/logger";

export const MAX_REPORT_QUEUE_LENGTH = 1000;

export type ReportStatus =
  // No connected Connector has reporting enabled.
  | { type: "disconnected" }
  | { type: "closed" }
  | { type: "forward"; controlId: number };

export class DaemonReportServiceBridge implements DriverReportService {
  private status: ReportStatus = { type: "disconnected" };
  private readonly queue: ReportEventData[] = [];
  private draining = false;

  constructor(
    private readonly send: (controlId: number, data: ReportEventData) => void,
  ) {}

  init(_manualConnect: boolean | undefined): void {
    // The actual reporting service is initialized in the Connector process.
  }

  report(eventName: string, metrics: any, categories: any): void {
    if (this.status.type === "closed") {
      return;
    }
    const data: ReportEventData = {
      eventName,
      metrics: metrics ?? null,
      categories: categories ?? null,
    };
    if (this.status.type === "disconnected") {
      if (this.queue.length >= MAX_REPORT_QUEUE_LENGTH) {
        this.queue.shift();
      }
      this.queue.push(data);
    } else {
      try {
        this.send(this.status.controlId, data);
      } catch (error) {
        defaultLogger.warn(`Failed to forward daemon report: ${String(error)}`);
      }
    }
  }

  updateStatus(status: ReportStatus): void {
    if (this.status.type === "closed") {
      return;
    }
    this.status = status;
    this.drain();
  }

  private drain(): void {
    if (this.draining) {
      return;
    }
    this.draining = true;
    try {
      while (this.queue.length > 0 && this.status.type === "forward") {
        // Dequeue before sending: a failed send is not replayed to another
        // Connector, and synchronous disconnect callbacks can change status.
        const data = this.queue.shift()!;
        this.report(data.eventName, data.metrics, data.categories);
      }
    } finally {
      this.draining = false;
    }
  }

  close(): void {
    this.status = { type: "closed" };
    this.queue.length = 0;
  }
}
