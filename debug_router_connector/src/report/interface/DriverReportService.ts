// Copyright 2024 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

export interface DriverReportService {
  init(manualConnect: boolean | undefined): void;
  report(eventName: string, metrics: any, categories: any): void;
}

let reportService: DriverReportService | null = null;

// All enabled Connector instances in this module reuse the first initialized
// service. Closing a Connector must not restart the shared reporting SDK.
export function initDriverReportService(
  service: DriverReportService | null | undefined,
  manualConnect: boolean | undefined,
): DriverReportService | null {
  if (!service) {
    return null;
  }
  if (!reportService) {
    service.init(manualConnect);
    reportService = service;
  }
  return reportService;
}

export function setDriverReportService(service: DriverReportService | null) {
  reportService = service;
}

export function getDriverReportService(): DriverReportService | null {
  return reportService;
}
