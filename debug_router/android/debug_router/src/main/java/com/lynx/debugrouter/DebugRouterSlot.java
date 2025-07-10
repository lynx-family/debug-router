// Copyright 2024 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

package com.lynx.debugrouter;

import android.view.View;
import androidx.annotation.Nullable;
import com.lynx.debugrouter.log.LLog;
import java.lang.reflect.Method;
import java.util.Map;

public class DebugRouterSlot {
  private static final String TAG = "DebugRouterSlot";

  private int mSessionId;
  private DebugRouterSlotDelegate mDelegate;
  private boolean mPlugged;
  private String mType = "";

  public DebugRouterSlot(DebugRouterSlotDelegate delegate) {
    mDelegate = delegate;
  }

  public int plug() {
    pull();
    mSessionId = DebugRouter.getInstance().plug(this);
    mPlugged = true;
    return mSessionId;
  }

  public void pull() {
    if (mPlugged) {
      DebugRouter.getInstance().pull(mSessionId);
      mPlugged = false;
    }
  }

  public void send(String message) {
    DebugRouter.getInstance().send(message);
  }

  public void sendData(String type, String data) {
    DebugRouter.getInstance().sendData(type, mSessionId, data);
  }

  public void sendData(String type, String data, int mark) {
    DebugRouter.getInstance().sendData(type, mSessionId, data, mark);
  }

  public void sendAsync(String message) {
    DebugRouter.getInstance().sendAsync(message);
  }

  public void sendDataAsync(String type, String data) {
    DebugRouter.getInstance().sendDataAsync(type, mSessionId, data);
  }

  @Deprecated
  public void sendDataAsync(String type, String data, int mark) {
    DebugRouter.getInstance().sendDataAsync(type, mSessionId, data, mark);
  }

  public String getTemplateUrl() {
    if ((mDelegate != null) && (mDelegate.getTemplateUrl() != null)) {
      return mDelegate.getTemplateUrl();
    }
    return "___UNKNOWN___";
  }

  @Nullable
  @Deprecated
  public View getTemplateView() {
    if (mDelegate != null) {
      try {
        Class ownerClass = mDelegate.getClass();
        Method method = ownerClass.getMethod("getTemplateView");
        Object obj = method.invoke(mDelegate);
        View view = (View) obj;
        return view;
      } catch (Exception exception) {
        LLog.e(TAG, "failed to invoke getTemplateView");
      }
    }
    return null;
  }

  public void onMessage(String type, String message) {
    if (mDelegate != null) {
      mDelegate.onMessage(type, message);
    }
  }

  @Deprecated
  public void dispatchDocumentUpdated() {
    String data = MessageAssembler.assembleDispatchDocumentUpdated();
    sendDataAsync("CDP", data);
  }

  @Deprecated
  public void dispatchFrameNavigated(String url) {
    String data = MessageAssembler.assembleDispatchFrameNavigated(url);
    sendDataAsync("CDP", data);
  }

  @Deprecated
  public void clearScreenCastCache() {}

  @Deprecated
  public void dispatchScreencastVisibilityChanged(boolean status) {
    String data = MessageAssembler.assembleDispatchScreencastVisibilityChanged(status);
    sendDataAsync("CDP", data);
  }

  @Deprecated
  public void sendScreenCast(String data, Map<String, Float> metaData) {
    String msg = MessageAssembler.assembleScreenCastFrame(mSessionId, data, metaData);
    sendDataAsync("CDP", msg);
  }

  public void setType(String type) {
    mType = type;
  }

  public String getType() {
    return mType;
  }
}
