/*
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Copyright 2024 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

package com.lynx.debugrouter.log;

import android.util.Log;

public abstract class AbsLogDelegate implements ILogDelegate {
  public final static int TYPE_OVERRIDE = 1; // type override for log implementation
  public final static int TYPE_INC = 2; // type increment for log implementation
  public int mMinimumLoggingLevel = Log.VERBOSE;
  /**
   * Indicates log delegate type
   * @return
   */
  public int type() {
    return TYPE_INC;
  }

  public void setMinimumLoggingLevel(int level) {
    mMinimumLoggingLevel = level;
  }

  public int getMinimumLoggingLevel() {
    return mMinimumLoggingLevel;
  }

  public boolean isLoggable(int level) {
    return mMinimumLoggingLevel <= level;
  }

  public void v(String tag, String msg) {
    println(Log.VERBOSE, tag, msg);
  }

  public void d(String tag, String msg) {
    println(Log.DEBUG, tag, msg);
  }

  public void i(String tag, String msg) {
    println(Log.INFO, tag, msg);
  }

  public void w(String tag, String msg) {
    println(Log.WARN, tag, msg);
  }

  public void e(String tag, String msg) {
    println(Log.ERROR, tag, msg);
  }

  /**
   * Note: this gets forwarded to {@code android.util.Log.e} as {@code android.util.Log.wtf} might
   * crash the app.
   */
  @Override
  public void k(String tag, String msg) {
    println(Log.ERROR, tag, msg);
  }

  @Override
  public void log(int priority, String tag, String msg) {
    println(priority, tag, msg);
  }

  private void println(int priority, String tag, String msg) {
    if (tag != null && msg != null) {
      Log.println(priority, tag, msg);
    }
  }
}
