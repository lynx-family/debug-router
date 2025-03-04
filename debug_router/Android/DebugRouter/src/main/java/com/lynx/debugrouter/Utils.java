// Copyright 2024 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

package com.lynx.debugrouter;

import android.app.Application;
import android.content.Context;
import com.lynx.debugrouter.log.LLog;

public class Utils {
  private static final String TAG = "DebugRouterUtils";
  private static Application context;

  public static Application getApplicationContext() {
    if (context != null) {
      return context;
    }
    try {
      context = (Application) Class.forName("android.app.ActivityThread")
                    .getMethod("currentApplication")
                    .invoke(null, (Object[]) null);
    } catch (Exception e) {
      LLog.e(TAG, "get application context exception:" + e.toString());
    }
    return context;
  }
}
