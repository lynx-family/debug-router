// Copyright 2024 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

package com.lynx.debugrouter.base.report;
import com.lynx.debugrouter.base.service.IRouterServiceProvider;
import org.json.JSONObject;

public interface IDebugRouterReportService extends IRouterServiceProvider {
  public void init(DebugRouterMetaInfo DebugRouterMetaInfo);
  public void report(
      String eventName, JSONObject category, JSONObject metric, JSONObject logExtend);
}
