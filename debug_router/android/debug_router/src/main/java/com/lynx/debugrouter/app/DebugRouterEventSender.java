// Copyright 2023 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

package com.lynx.debugrouter.app;

import com.lynx.debugrouter.DebugRouter;
import com.lynx.debugrouter.log.LLog;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * Send asynchronous event
 * <p>
 * it can be used to return asynchronous result of MessageHandler
 */
public class DebugRouterEventSender {
  private static final String TAG = "MessageHandleCallback.Sender";

  public static void send(String eventName, MessageHandleResult result) {
    JSONObject jsonObject = new JSONObject();
    try {
      jsonObject.put("method", eventName);
      jsonObject.put("params", result.toJson());
      DebugRouter.getInstance().sendDataAsync("CDP", -1, jsonObject.toString());
    } catch (JSONException e) {
      LLog.e(TAG, "send failed:" + e.getMessage());
    }
  }
}
