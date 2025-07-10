// Copyright 2024 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

package com.lynx.debugrouter;

import static com.lynx.debugrouter.app.MessageHandleResult.CODE_HANDLE_FAILED;
import static com.lynx.debugrouter.app.MessageHandleResult.CODE_NOT_IMPLEMENTED;

import androidx.annotation.Keep;
import androidx.annotation.NonNull;
import com.lynx.debugrouter.app.MessageHandleResult;
import com.lynx.debugrouter.app.MessageHandler;
import com.lynx.debugrouter.base.CalledByNative;
import com.lynx.debugrouter.log.LLog;
import java.lang.ref.WeakReference;
import java.util.HashMap;
import java.util.Iterator;
import java.util.Map;
import org.json.JSONException;
import org.json.JSONObject;

@Keep
public class MessageHandlerDelegate implements MessageHandler {
  private static final String TAG = "MessageHandlerDelegate";

  public MessageHandlerDelegate(@NonNull MessageHandler handler) {
    this.handler = handler;
  }

  @Override
  public MessageHandleResult handle(Map<String, String> params) {
    LLog.i(TAG, "handle: " + params);
    return handler.handle(params);
  }

  @CalledByNative
  public String handleAppAction(String params) {
    Map<String, String> map = new HashMap<>();
    try {
      JSONObject json = new JSONObject(params);
      for (Iterator<String> it = json.keys(); it.hasNext();) {
        String key = it.next();
        map.put(key, json.optString(key));
      }
    } catch (JSONException e) {
      LLog.e(TAG, "params resolve error:" + params);
      return new MessageHandleResult(CODE_HANDLE_FAILED, "params resolve error").toJsonString();
    }
    MessageHandleResult result = handle(map);
    if (result == null) {
      return new MessageHandleResult().toJsonString();
    }
    return result.toJsonString();
  }

  @Override
  @CalledByNative
  public String getName() {
    return handler.getName();
  }

  // TODO(txl): weak this reference
  private MessageHandler handler;
}
