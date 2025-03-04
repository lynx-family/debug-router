// Copyright 2024 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

package com.lynx.debugrouter;

import androidx.annotation.Keep;
import com.lynx.debugrouter.base.CalledByNative;
import com.lynx.debugrouter.log.LLog;

@Keep
public class NativeStateListenerDelegate {
  private static final String TAG = "NativeStateListenerDelegate";
  // TODO weak
  private StateListener listener;

  public NativeStateListenerDelegate(StateListener listener) {
    this.listener = listener;
  }

  @CalledByNative
  public void onOpen(String type) {
    if (listener != null) {
      switch (type) {
        case "websocket":
          listener.onOpen(ConnectionType.WebSocket);
          break;
        case "usb":
          listener.onOpen(ConnectionType.USB);
          break;
        default:
          LLog.e(TAG, "unknown type: " + type);
      }
    }
  }

  @CalledByNative
  public void onClose(int code, String reason) {
    if (listener != null) {
      listener.onClose(code, reason);
    }
  }

  @CalledByNative
  public void onMessage(String text) {
    if (listener != null) {
      listener.onMessage(text);
    }
  }

  @CalledByNative
  public void onError(String error) {
    if (listener != null) {
      listener.onError(error);
    }
  }
}
