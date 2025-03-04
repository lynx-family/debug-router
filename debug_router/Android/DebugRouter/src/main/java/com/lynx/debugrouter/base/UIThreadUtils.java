// Copyright 2019 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

package com.lynx.debugrouter.base;

import android.os.Handler;
import android.os.Looper;
import androidx.annotation.Nullable;

public class UIThreadUtils {
  @Nullable private static Handler sMainHandler;

  public static boolean isOnUiThread() {
    return Looper.getMainLooper().getThread() == Thread.currentThread();
  }
  public static void runOnUiThread(Runnable runnable) {
    synchronized (UIThreadUtils.class) {
      if (sMainHandler == null) {
        sMainHandler = new Handler(Looper.getMainLooper());
      }
    }
    sMainHandler.post(runnable);
  }

  public static void runOnUiThreadImmediately(Runnable runnable) {
    if (isOnUiThread()) {
      runnable.run();
    } else {
      runOnUiThread(runnable);
    }
  }

  public static void runOnUiThread(Runnable runnable, long delayMs) {
    synchronized (UIThreadUtils.class) {
      if (sMainHandler == null) {
        sMainHandler = new Handler(Looper.getMainLooper());
      }
    }
    sMainHandler.postDelayed(runnable, delayMs);
  }

  public static void runOnUiThreadAtTime(Runnable runnable, Object token, long uptimeMillis) {
    synchronized (UIThreadUtils.class) {
      if (sMainHandler == null) {
        sMainHandler = new Handler(Looper.getMainLooper());
      }
    }
    sMainHandler.postAtTime(runnable, token, uptimeMillis);
  }

  public static void removeCallbacks(Runnable r, Object token) {
    synchronized (UIThreadUtils.class) {
      if (sMainHandler == null) {
        sMainHandler = new Handler(Looper.getMainLooper());
      }
    }
    sMainHandler.removeCallbacks(r, token);
  }
}
