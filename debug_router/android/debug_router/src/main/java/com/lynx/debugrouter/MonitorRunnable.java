// Copyright 2022 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

package com.lynx.debugrouter;

import com.lynx.debugrouter.log.LLog;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;

class MonitorRunnable implements Runnable {
  private static final String TAG = "MonitorRunnable";
  private static final String CONNECT_RUNNABLE = "connect";
  private static final long TIME_THRESHOLD = 3000_000_000L; // 3s
  private static ScheduledExecutorService sTimer = Executors.newScheduledThreadPool(1);
  private static volatile MonitorRunnable sCurMonitorRunnable = null;
  private static volatile int sRunnableCount = 0;
  private Runnable mRunnable;
  private String mRunnableTag;
  private Future mMonitorTask;

  public MonitorRunnable(Runnable runnable, String runnableTag) {
    this.mRunnable = runnable;
    this.mRunnableTag = runnableTag;
    sRunnableCount++;
    if (CONNECT_RUNNABLE.equals(runnableTag)) {
      LLog.i(TAG, "MonitorRunnableCount: " + sRunnableCount);
    }
    mMonitorTask = sTimer.schedule(new Runnable() {
      @Override
      public void run() {
        LLog.e(TAG,
            MonitorRunnable.this.mRunnable.hashCode() + runnableTag
                + " exe timeout:" + TIME_THRESHOLD + " sCurMonitorRunnable:" + sCurMonitorRunnable);
      }
    }, TIME_THRESHOLD, TimeUnit.NANOSECONDS);
  }

  @Override
  public void run() {
    sCurMonitorRunnable = this;
    long startTime = System.nanoTime();
    mRunnable.run();
    long duration = System.nanoTime() - startTime;
    sRunnableCount--;
    mMonitorTask.cancel(false);
    if (duration >= (TIME_THRESHOLD / 3)) {
      LLog.w(TAG, mRunnable.hashCode() + mRunnableTag + " exe time is too large:" + duration);
    }
    sCurMonitorRunnable = null;
  }

  @Override
  public String toString() {
    return "MonitorRunnable_" + mRunnable.hashCode() + mRunnableTag;
  }
}
