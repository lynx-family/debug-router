// Copyright 2024 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

package com.lynx.debugrouter;

import androidx.annotation.Keep;
import com.lynx.debugrouter.base.CalledByNative;

// Obsoleted legacy protocol: public Target adapter name.
@Keep
public class NativeSlotDelegate {
  // TODO weak
  private DebugRouterSlot target;

  private String url;

  private String type;

  public NativeSlotDelegate(DebugRouterSlot target) {
    this.target = target;
    this.url = target.getTemplateUrl();
    this.type = target.getType();
  }

  @CalledByNative
  public void onMessage(String type, String message) {
    if (target != null) {
      target.onMessage(type, message);
    }
  }

  @CalledByNative
  public String getUrl() {
    return url;
  }

  @CalledByNative
  public String getType() {
    return type;
  }
}
