// Copyright 2023 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

package com.lynx.debugrouter.base.report;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import com.lynx.debugrouter.base.service.DebugRouterServiceCenter;
import com.lynx.debugrouter.log.LLog;
import org.json.JSONObject;

public class DebugRouterReportServiceUtil {
  private static final String TAG = "DebugRouterReportServiceUtil";

  public static void init(@NonNull DebugRouterMetaInfo info) {
    if (InnerClass.service == null) {
      LLog.i(TAG, "init: DebugRouterReportService == null");
      return;
    }
    InnerClass.service.init(info);
  }

  public static void report(@NonNull String eventName, @Nullable JSONObject category,
      @Nullable JSONObject metric, @Nullable JSONObject logExtend) {
    if (InnerClass.service == null) {
      LLog.i(TAG, "report: DebugRouterReportService == null");
      return;
    }
    if (category == null) {
      category = new JSONObject();
    }
    if (metric == null) {
      metric = new JSONObject();
    }
    if (logExtend == null) {
      logExtend = new JSONObject();
    }
    eventName = "New" + eventName;
    InnerClass.service.report(eventName, category, metric, logExtend);
  }

  private static class InnerClass {
    private static final IDebugRouterReportService service =
        DebugRouterServiceCenter.instance().getService(IDebugRouterReportService.class);
  }
}
