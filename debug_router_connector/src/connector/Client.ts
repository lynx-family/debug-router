// Copyright 2024 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

export abstract class Client {
  protected static messageIdCounter = 1;
  abstract clientId(): number;
  abstract close(): void;
  abstract sendCustomizedMessage(
    method: string,
    params: Object,
    sessionId: number,
    type: string,
  ): Promise<string>;
}
