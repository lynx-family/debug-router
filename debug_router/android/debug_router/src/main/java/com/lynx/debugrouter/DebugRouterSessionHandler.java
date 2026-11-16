// Copyright 2024 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

package com.lynx.debugrouter;

import androidx.annotation.Keep;

// Obsoleted legacy protocol: Session callbacks describe Targets.
@Keep
public interface DebugRouterSessionHandler {
  public void onSessionCreate(int targetId, String url);
  public void onSessionDestroy(int targetId);
  public void onMessage(String message, String type, int targetId);
}
