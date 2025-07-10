// Copyright 2024 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

package com.lynx.debugrouter.base;

public interface MessageTransceiverStateListener {
  void onOpen(MessageTransceiver transceiver);
  void onClose(MessageTransceiver transceiver, int code, String reason);
  void onMessage(MessageTransceiver transceiver, String text);
  void onError(MessageTransceiver transceiver, Throwable t);
}
