// Copyright 2024 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

package com.lynx.debugrouter.base.net;

import com.lynx.debugrouter.base.NativeMessageTransceiver;
import com.lynx.debugrouter.base.service.IRouterServiceProvider;

public interface IDebugRouterWebSocketService extends IRouterServiceProvider {
  // long processPtr, will be removed after sinking to the C++ layer
  NativeMessageTransceiver init(long processPtr);
}
