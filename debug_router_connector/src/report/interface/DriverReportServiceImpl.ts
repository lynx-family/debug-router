// Copyright 2024 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

import type { DriverReportService } from "./DriverReportService";

/**
 * Daemon-local DriverReportService customization point.
 *
 * Import and construct the actual reporting implementation here when
 * reporting is required. Keeping the delegate null disables reporting by
 * default without requiring a report service object to cross the process
 * boundary.
 */
function createDriverReportService(): DriverReportService | null {
  return null;
}

export class DriverReportServiceImpl implements DriverReportService {
  private readonly delegate = createDriverReportService();

  init(manualConnect: boolean | undefined): void {
    this.delegate?.init(manualConnect);
  }

  report(eventName: string, metrics: any, categories: any): void {
    this.delegate?.report(eventName, metrics, categories);
  }
}
