// Copyright 2024 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

package com.lynx.debugrouter.base;

import androidx.annotation.Keep;

@Keep
public interface NativeStateListener {
  void onOpen();
  void onClose();
  void onError(String error);

  void onMessage(String message);
}
