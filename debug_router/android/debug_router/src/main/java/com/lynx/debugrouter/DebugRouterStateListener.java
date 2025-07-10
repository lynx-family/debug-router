// Copyright 2024 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

package com.lynx.debugrouter;

import android.content.Context;
import android.widget.Toast;
import com.lynx.debugrouter.base.UIThreadUtils;
import com.lynx.debugrouter.log.LLog;

public class DebugRouterStateListener implements StateListener {
  private static final String TAG = "DebugRouterStateListener";

  private long mStartTime = -1;
  @Override
  public void onOpen(ConnectionType type) {
    LLog.i(TAG, "onOpen: " + type);
    // TODO(zhoumingsong.smile) add transiver_id to report time
    mStartTime = System.nanoTime();
  }

  @Override
  public void onClose(int code, String reason) {
    // TODO(zhoumingsong.smile) add transiver_id to report time
    // TODO(zhoumingsong.smile) Toast
  }

  @Override
  public void onMessage(String text) {
    // do nothing
  }

  @Override
  public void onError(String error) {
    // TODO(zhoumingsong.smile) add transiver_id to report time
    // TODO(zhoumingsong.smile) Toast
  }

  private void toastUser(int mRetryTimes, Throwable t, boolean isWebSocket) {
    if (!isWebSocket) {
      return;
    }
    if (mRetryTimes != 0) {
      LLog.i(TAG, "only toast in first connection when error occurs");
      return;
    }
    if (t == null) {
      LLog.w(TAG, "toastUser: t == null");
      return;
    }
    Context context = Utils.getApplicationContext();
    if (context == null) {
      return;
    }
    final String message = t.getMessage();
    if (message != null
        && (message.contains("ERR_INTERNET_DISCONNECTED")
            || message.contains("java.net.ConnectException"))) {
      UIThreadUtils.runOnUiThreadImmediately(new Runnable() {
        @Override
        public void run() {
          Toast.makeText(context, "The internet is disconnected", Toast.LENGTH_SHORT).show();
        }
      });
      return;
    }
    if (message != null
        && (message.contains("WebSocket opening handshake timed out")
            || message.contains("java.net.SocketTimeoutException"))) {
      UIThreadUtils.runOnUiThreadImmediately(new Runnable() {
        @Override
        public void run() {
          Toast
              .makeText(context,
                  "The network connection timed out. Please check if desktop and phone are on the same network",
                  Toast.LENGTH_LONG)
              .show();
        }
      });
    }
  }
}
