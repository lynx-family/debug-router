// Copyright 2024 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

package com.lynx.debugrouter.base;

public interface MessageTransceiver {
  boolean connect(String url);
  void disconnect();

  void send(String text);
  void setStateListener(MessageTransceiverStateListener listener);
  void removeStateListener(MessageTransceiverStateListener listener);
  long queueSize();
}
