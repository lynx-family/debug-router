// Copyright 2023 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

package com.lynx.debugrouter.app;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import com.lynx.debugrouter.log.LLog;
import java.util.HashMap;
import java.util.Map;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * Data Structure for MessageHandler's result
 */
public class MessageHandleResult {
  public static final int CODE_NOT_IMPLEMENTED = -2;
  public static final int CODE_HANDLE_FAILED = -1;
  public static final int CODE_HANDLE_SUCCESSFULLY = 0;

  private static final String TAG = "Result";
  private int mCode = CODE_NOT_IMPLEMENTED;
  private String mMessage = "not implemented";

  private final Map<String, Object> data = new HashMap<>();

  /**
   *  MessageHandleResult
   *
   * @param code    result code
   * @param message result message
   */
  public MessageHandleResult(int code, @NonNull String message) {
    this(code, message, null);
  }

  /**
   * Success with data
   *
   * @param data the result
   */
  public MessageHandleResult(@Nullable Map<String, Object> data) {
    this(CODE_HANDLE_SUCCESSFULLY, "", data);
  }

  /**
   * Success without data
   */
  public MessageHandleResult() {
    this(null);
  }

  /**
   *  MessageHandleResult
   *
   * @param code    result's code
   * @param message result's message
   * @param data result's data
   */
  public MessageHandleResult(
      int code, @NonNull String message, @Nullable Map<String, Object> data) {
    this.mCode = code;
    this.mMessage = message;
    if (data != null && data.size() > 0) {
      this.data.putAll(data);
    }
  }

  public String toJsonString() {
    return toJson().toString();
  }

  public JSONObject toJson() {
    JSONObject jsonObject = new JSONObject();
    try {
      jsonObject.put("code", mCode).put("message", mMessage);
      for (Map.Entry<String, Object> entry : data.entrySet()) {
        jsonObject.put(entry.getKey(), entry.getValue());
      }
    } catch (JSONException e) {
      LLog.e(TAG, "toJsonString error:" + e.getMessage());
    }
    return jsonObject;
  }

  public Map<String, Object> getData() {
    return data;
  }
}
