// Copyright 2024 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

package com.lynx.debugrouter.base.service;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import com.lynx.debugrouter.log.LLog;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

public class DebugRouterServiceCenter {
  private static final String TAG = "DebugRouterServiceCenter";
  private static volatile DebugRouterServiceCenter instance = null;

  public static DebugRouterServiceCenter instance() {
    if (instance == null) {
      synchronized (DebugRouterServiceCenter.class) {
        if (instance == null) {
          instance = new DebugRouterServiceCenter();
        }
      }
    }
    return instance;
  }

  private Map<Class<? extends IRouterServiceProvider>, IRouterServiceProvider> serviceMap =
      new ConcurrentHashMap<>();

  @Nullable
  public <T extends IRouterServiceProvider> T getService(Class<T> clazz) {
    if (serviceMap.containsKey(clazz)) {
      return (T) serviceMap.get(clazz);
    } else {
      LLog.e(TAG, clazz.getSimpleName() + " is unregistered");
      return null;
    }
  }

  public void registerService(
      Class<? extends IRouterServiceProvider> clazz, @NonNull IRouterServiceProvider instance) {
    serviceMap.put(clazz, instance);
  }

  public void unregisterService(
      Class<? extends IRouterServiceProvider> clazz, IRouterServiceProvider instance) {
    serviceMap.remove(clazz, instance);
  }

  public void unregisterAllService() {
    serviceMap.clear();
  }
}
