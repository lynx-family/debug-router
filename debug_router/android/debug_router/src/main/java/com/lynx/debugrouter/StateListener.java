// Copyright 2024 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

package com.lynx.debugrouter;

import androidx.annotation.Keep;

@Keep
public interface StateListener {
  void onOpen(ConnectionType type);
  void onClose(int code, String reason);

  // TODO Listening to all messages is a very costly thing and should be prohibited. Only the
  // necessary ones should be listened to.
  @Deprecated void onMessage(String text);
  void onError(String error);
}
