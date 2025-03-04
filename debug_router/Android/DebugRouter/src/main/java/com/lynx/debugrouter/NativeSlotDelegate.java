// Copyright 2024 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

package com.lynx.debugrouter;

import androidx.annotation.Keep;
import com.lynx.debugrouter.base.CalledByNative;

@Keep
public class NativeSlotDelegate {
  // TODO weak
  private DebugRouterSlot slot;

  private String url;

  private String type;

  public NativeSlotDelegate(DebugRouterSlot slot) {
    this.slot = slot;
    this.url = slot.getTemplateUrl();
    this.type = slot.getType();
  }

  @CalledByNative
  public void onMessage(String type, String message) {
    if (slot != null) {
      slot.onMessage(type, message);
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
