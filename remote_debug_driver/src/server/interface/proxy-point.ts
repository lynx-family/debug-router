// Copyright 2025 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

// Aspect point, allowing customization of schema information
export interface IRemoteDebugDriverProxy {
  generateRemoteDebugProxy?: (
    protocol: string,
    websocketUrl: string,
    roomId: string,
    float: string
  ) => string;
  generateDevtoolUrlProxy?: (websocketUrl: string, roomId: string) => string;
}
