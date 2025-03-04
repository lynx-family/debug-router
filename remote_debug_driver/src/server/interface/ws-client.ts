// Copyright 2025 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

export interface IWebSocketClient {
  postMessage: (payload: string) => void;
  onMessage: (cb: (message: string) => void) => void;
  onOpen: (cb: () => void) => void;
  onClose: (cb: () => void) => void;
  close?: (...args: any[]) => any;
}

export type Klass4WebsocketClient = new (url: string) => IWebSocketClient;
