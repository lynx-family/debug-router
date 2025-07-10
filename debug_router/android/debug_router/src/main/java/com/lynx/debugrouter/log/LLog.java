// Copyright 2024 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

package com.lynx.debugrouter.log;

import android.util.Log;
import androidx.annotation.Keep;
import com.lynx.debugrouter.DebugRouter;
import com.lynx.debugrouter.base.CalledByNative;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

@Keep
public class LLog {
  private static final String TAG = "DebugRouter_LLog";

  public static final int VERBOSE = Log.VERBOSE;

  public static final int DEBUG = Log.DEBUG;

  public static final int INFO = Log.INFO;

  public static final int WARN = Log.WARN;

  public static final int ERROR = Log.ERROR;

  public static final int ASSERT = Log.ASSERT;

  public static final int REPORT = Log.ASSERT + 1;

  private static int sHandlerId = -1;

  private static final ConcurrentHashMap<Integer, ILogDelegate> sHandlerMap =
      new ConcurrentHashMap<>();
  private static Integer currentId = 0;

  private static final int sDefaultLogLevel = ERROR;
  private static int sNativeMinLogLevel = sDefaultLogLevel;
  private static int[] sNativeLevelMap;

  public static void setMinimumLoggingLevel(int level) {
    ensureNativeLibraryLoaded();
    if (sNativeMinLogLevel != level) {
      sNativeMinLogLevel = level;
    }
    try {
      initNativeLogLevelMap();
      nativeSetNativeMinLogLevel(sNativeLevelMap[level]);
    } catch (Throwable t) {
      sNativeMinLogLevel = sDefaultLogLevel; // reset default
      nativeSetNativeMinLogLevel(sNativeLevelMap[sNativeMinLogLevel]);
    }
  }

  public static synchronized int addLoggingDelegate(AbsLogDelegate delegate) {
    ensureNativeLibraryLoaded();
    if (delegate == null) {
      return -1;
    }
    Integer id = ++currentId;
    if (delegate.type() == AbsLogDelegate.TYPE_OVERRIDE) {
      if (sHandlerId != -1) {
        sHandlerMap.remove(sHandlerId);
      }
      sHandlerId = id;
      resetMinLogLevel();
    }
    sHandlerMap.put(id, delegate);
    nativeSetHasLoggingDelegate(true);
    return id;
  }

  public static synchronized void addDebugLoggingDelegate() {
    addLoggingDelegate(new AbsLogDelegate() {});
  }

  private static void ensureNativeLibraryLoaded() {
    if (!DebugRouter.isNativeLibraryLoaded()) {
      DebugRouter.loadNativeLibrary();
    }
  }

  private static void resetMinLogLevel() {
    for (Map.Entry<Integer, ILogDelegate> entrys : sHandlerMap.entrySet()) {
      ILogDelegate delegate = entrys.getValue();
      if (sNativeMinLogLevel == sDefaultLogLevel) {
        sNativeMinLogLevel = delegate.getMinimumLoggingLevel();
      } else {
        sNativeMinLogLevel = Math.min(sNativeMinLogLevel, delegate.getMinimumLoggingLevel());
      }
    }
    setMinimumLoggingLevel(sNativeMinLogLevel);
  }

  public static synchronized void removeLoggingDelegate(int delegateId) {
    sHandlerMap.remove(delegateId);
  }

  public static int getMinimumLoggingLevel() {
    ILogDelegate delegate = sHandlerMap.get(sHandlerId);
    if (delegate != null) {
      return delegate.getMinimumLoggingLevel();
    }
    return INFO;
  }

  public static void v(String tag, String msg) {
    internalLog(VERBOSE, tag, msg);
  }

  public static void d(String tag, String msg) {
    internalLog(DEBUG, tag, msg);
  }

  public static void i(String tag, String msg) {
    internalLog(INFO, tag, msg);
  }

  public static void w(String tag, String msg) {
    internalLog(WARN, tag, msg);
  }

  public static void e(String tag, String msg) {
    internalLog(ERROR, tag, msg);
  }

  /**
   * Not only the output but also the report
   * @param tag
   * @param msg
   */
  public static void report(String tag, String msg) {
    internalLog(REPORT, tag, msg);
  }

  public static void internalLog(int level, String tag, String msg) {
    internalLog(level, tag, msg, LogSource.JAVA);
  }

  public static void internalLog(int level, String tag, String msg, LogSource source) {
    for (ILogDelegate d : sHandlerMap.values()) {
      if (!d.isLoggable(level)) {
        continue;
      }
      switch (level) {
        case VERBOSE:
          d.v(tag, msg);
          break;
        case DEBUG:
          d.d(tag, msg);
          break;
        case INFO:
          d.i(tag, msg);
          break;
        case WARN:
          d.w(tag, msg);
          break;
        case ERROR:
          d.e(tag, msg);
          break;
        case REPORT:
          d.k(tag, msg);
          break;
      }
    }
  }

  private static void initNativeLogLevelMap() {
    if (sNativeLevelMap == null) {
      sNativeLevelMap = new int[9];
      sNativeLevelMap[VERBOSE] = -1;
      sNativeLevelMap[DEBUG] = 0;
      sNativeLevelMap[INFO] = 0;
      sNativeLevelMap[WARN] = 1;
      sNativeLevelMap[ERROR] = 2;
      sNativeLevelMap[ASSERT] = 3;
      sNativeLevelMap[REPORT] = 5;
    }
  }

  @CalledByNative
  private static void log(int priority, String tag, String msg) {
    try {
      if (priority != ASSERT) {
        internalLog(priority, tag, msg, LogSource.Native);
      }
    } catch (Throwable e) {
      Log.e(TAG, e.getMessage());
    }
  }

  private static native void nativeSetNativeMinLogLevel(int level);
  private static native void nativeSetHasLoggingDelegate(boolean has);
}
