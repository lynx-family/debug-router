// Copyright 2024 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

package com.lynx.debugrouter;

import android.os.Handler;
import android.os.HandlerThread;
import android.os.Process;

public class ThreadManager {
  private static volatile ThreadManager sInstance;
  private HandlerThread mWorkThread;
  private Handler mHandler;

  public static ThreadManager getInstance() {
    if (sInstance == null) {
      synchronized (ThreadManager.class) {
        if (sInstance == null) {
          sInstance = new ThreadManager();
        }
      }
    }
    return sInstance;
  }

  private ThreadManager() {
    mWorkThread = new HandlerThread("DebugRouterThread", Process.THREAD_PRIORITY_BACKGROUND);
    mWorkThread.start();
    mHandler = new Handler(mWorkThread.getLooper());
  }

  public void post(Runnable runnable) {
    mHandler.post(runnable);
  }
}
