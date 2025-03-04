// Copyright 2024 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

package com.lynx.debugrouter;

import androidx.annotation.Keep;
import com.lynx.debugrouter.base.CalledByNative;
import java.lang.ref.WeakReference;

@Keep
public class GlobalHandlerDelegate implements DebugRouterGlobalHandler {
  public GlobalHandlerDelegate(DebugRouterGlobalHandler handler) {
    this.handler = handler;
  }

  @Override
  @CalledByNative
  public void onMessage(String type, int sessionId, String message) {
    if (handler != null) {
      handler.onMessage(type, sessionId, message);
    }
  }

  // TODO weak
  private DebugRouterGlobalHandler handler;

  @Override
  @CalledByNative
  public void openCard(String url) {
    if (handler != null) {
      handler.openCard(url);
    }
  }
}
