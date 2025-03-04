// Copyright 2024 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

package com.lynx.debugrouter;

import java.util.Map;
import org.json.JSONObject;

public class MessageAssembler {
  public static String assembleDispatchDocumentUpdated() {
    return nativeAssembleDispatchDocumentUpdated();
  }

  public static String assembleDispatchFrameNavigated(String url) {
    return nativeAssembleDispatchFrameNavigated(url);
  }

  public static String assembleDispatchScreencastVisibilityChanged(boolean status) {
    return nativeAssembleDispatchScreencastVisibilityChanged(status);
  }

  public static String assembleScreenCastFrame(
      int sessionId, String data, Map<String, Float> metaData) {
    return nativeAssembleScreenCastFrame(sessionId, data, new JSONObject(metaData).toString());
  }

  public static native String nativeAssembleDispatchDocumentUpdated();
  public static native String nativeAssembleDispatchFrameNavigated(String url);

  public static native String nativeAssembleDispatchScreencastVisibilityChanged(boolean status);

  public static native String nativeAssembleScreenCastFrame(
      int sessionId, String data, String metaData);
}
