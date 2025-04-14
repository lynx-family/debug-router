// Copyright 2024 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

package com.lynx.debugrouter;

import androidx.annotation.Keep;
import com.lynx.debugrouter.base.CalledByNative;
import com.lynx.debugrouter.base.report.DebugRouterReportServiceUtil;
import com.lynx.debugrouter.log.LLog;
import org.json.JSONObject;

@Keep
public class NativeReportServiceDelegate {
  private static final String TAG = "NativeReportServiceDelegate";

  public NativeReportServiceDelegate() {}

  private static JSONObject stringToJSONObject(String jsonString) {
    try {
      return new JSONObject(jsonString);
    } catch (org.json.JSONException e) {
      LLog.e(TAG, "Failed to parse JSON: " + e.getMessage());
      return new JSONObject();
    }
  }

  @CalledByNative
  public void report(String eventName, String category, String metric, String extra) {
    JSONObject categoryObject = stringToJSONObject(category);
    JSONObject metricObject = stringToJSONObject(metric);
    JSONObject extraObject = stringToJSONObject(extra);
    DebugRouterReportServiceUtil.report(eventName, categoryObject, metricObject, extraObject);
  }
}
