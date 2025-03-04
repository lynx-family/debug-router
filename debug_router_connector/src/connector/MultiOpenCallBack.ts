// Copyright 2024 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

import { defaultLogger } from "../utils/logger";

export enum MultiOpenStatus {
  attached, // connector is available
  unattached, // connector is unavailable
  unInit,
}

export interface MultiOpenCallback {
  statusChanged: (status: MultiOpenStatus) => void;
}

export class DefaultMultiOpenCallback implements MultiOpenCallback {
  statusChanged(status: MultiOpenStatus): void {
    if (status === MultiOpenStatus.attached) {
      defaultLogger.debug("connector attached");
      return;
    }
    defaultLogger.debug("connector unattached");
  }
}
