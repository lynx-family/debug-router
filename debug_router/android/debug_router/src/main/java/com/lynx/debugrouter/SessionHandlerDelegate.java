// Copyright 2024 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

package com.lynx.debugrouter;

import androidx.annotation.Keep;
import com.lynx.debugrouter.base.CalledByNative;

@Keep
public class SessionHandlerDelegate implements DebugRouterSessionHandler {
  // TODO(txl): weak this ptr
  private DebugRouterSessionHandler handler;

  public SessionHandlerDelegate(DebugRouterSessionHandler handler) {
    this.handler = handler;
  }

  @Override
  @CalledByNative
  public void onSessionCreate(int sessionId, String url) {
    if (handler != null) {
      handler.onSessionCreate(sessionId, url);
    }
  }

  @Override
  @CalledByNative
  public void onSessionDestroy(int sessionId) {
    if (handler != null) {
      handler.onSessionDestroy(sessionId);
    }
  }

  @Override
  @CalledByNative
  public void onMessage(String message, String type, int sessionId) {
    if (handler != null) {
      handler.onMessage(message, type, sessionId);
    }
  }
}
