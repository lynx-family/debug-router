// Copyright 2024 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

package com.lynx.debugrouter;

import android.app.Application;
import android.content.Context;
import android.net.ConnectivityManager;
import android.os.Build;
import android.util.Log;
import android.view.View;
import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import com.lynx.debugrouter.app.MessageHandler;
import com.lynx.debugrouter.base.report.DebugRouterMetaInfo;
import com.lynx.debugrouter.base.report.DebugRouterReportServiceUtil;
import com.lynx.debugrouter.base.usb.USBTransTemplateUtil;
import com.lynx.debugrouter.log.LLog;
import java.lang.reflect.Method;
import java.util.HashMap;
import java.util.Map;
import java.util.UUID;
import java.util.WeakHashMap;
import org.json.JSONObject;

public class DebugRouter {
  private static final String TAG = "DebugRouter";

  private static volatile DebugRouter sInstance;

  private static boolean mIsNativeLibraryLoaded;

  private static final WeakHashMap<View, Integer> viewMap = new WeakHashMap<>();
  // TODO(txl): We need throw add and remove operations to the DebugRouter thread for execution
  private final Map<DebugRouterSessionHandler, Integer> mSessionHandlers = new HashMap<>();
  private final Map<DebugRouterGlobalHandler, Integer> mGlobalHandlers = new HashMap<>();

  private DebugRouter() {
    loadNativeLibrary();
    LLog.addDebugLoggingDelegate();
    nativeCreateDebugRouter();
    initAppInfo();
    DebugRouterReportServiceUtil.init(
        new DebugRouterMetaInfo(getVersion(), getCurrentProcessName()));
    DebugRouterReportServiceUtil.report("DebugRouterInit", null, null, null);
    addMessageHandler(new CallStaticVoidMethodHandler());
    addMessageHandler(new OpenUsbTransTemplateSwitchHandler());
    addMessageHandler(new ReceiveTemplateByUsbHandler());
    addStateListener(new DebugRouterStateListener());
    USBTransTemplateUtil.INSTANCE.addInterceptor();
  }

  private native void nativeCreateDebugRouter();

  public static DebugRouter getInstance() {
    if (sInstance == null) {
      synchronized (DebugRouter.class) {
        if (sInstance == null) {
          sInstance = new DebugRouter();
        }
      }
    }

    return sInstance;
  }

  public static boolean isNativeLibraryLoaded() {
    return mIsNativeLibraryLoaded;
  }

  public static void loadNativeLibrary() {
    if (!mIsNativeLibraryLoaded) {
      try {
        System.loadLibrary("lynxdebugrouter");
        mIsNativeLibraryLoaded = true;
      } catch (Throwable t) {
        Log.w(TAG, "failed to load debugrouter: " + t.toString());
      }
    }
  }

  private native String nativeGetRoomId();
  private native String nativeGetServerUrl();

  @Deprecated
  public String getRoomId() {
    return nativeGetRoomId();
  }

  @Deprecated
  public String getServerUrl() {
    return nativeGetServerUrl();
  }

  private void initAppInfo() {
    String manufacturer = Build.MANUFACTURER;
    String model = Build.MODEL;
    String deviceModel = model.startsWith(manufacturer) ? model : manufacturer + " " + model;

    String appPrcossName = getCurrentProcessName();
    // The default app's name is app's process name.
    // App(used the lynx devtool) will set app's name by using setAppInfo.
    nativeSetAppInfo("App", appPrcossName);

    nativeSetAppInfo("AppVersion", "1.0");
    // AppProcessName field is in order to distinguish multi process's
    // connections on android.
    nativeSetAppInfo("AppProcessName", appPrcossName);
    nativeSetAppInfo("manufacturer", manufacturer);

    nativeSetAppInfo("model", model);
    nativeSetAppInfo("deviceModel", deviceModel);
    nativeSetAppInfo("osVersion", Build.VERSION.RELEASE);
    nativeSetAppInfo("debugRouterVersion", getVersion());
    UUID id_string = UUID.randomUUID();
    // A process-level id that identifies the unique id of a debugRouter connection
    // If the connection is completely disconnected and then reconnected, a new
    // debugRouterId will
    // be generated
    nativeSetAppInfo("debugRouterId", id_string.toString());
  }

  public synchronized void setAppInfo(Map<String, String> appInfo) {
    setAppInfo(null, appInfo);
  }

  public synchronized void setAppInfo(Context context, Map<String, String> appInfo) {
    for (String key : appInfo.keySet()) {
      nativeSetAppInfo(key, appInfo.get(key));
    }
    nativeSetAppInfo("network", checkNetworkStatus(context));
  }

  private native void nativeSetAppInfo(String key, String value);

  public String getAppInfoByKey(String key) {
    return nativeGetAppInfoByKey(key);
  }

  private native String nativeGetAppInfoByKey(String key);

  public void addGlobalHandler(DebugRouterGlobalHandler handler) {
    if (handler == null) {
      return;
    }
    GlobalHandlerDelegate currHandler = new GlobalHandlerDelegate(handler);
    int handlerId = nativeAddNativeGlobalHandler(currHandler);
    mGlobalHandlers.put(handler, handlerId);
  }

  private native int nativeAddNativeGlobalHandler(GlobalHandlerDelegate handler);

  public boolean removeGlobalHandler(DebugRouterGlobalHandler handler) {
    if (handler == null) {
      return false;
    }
    Integer removedHandlerId = mGlobalHandlers.remove(handler);
    if (removedHandlerId != null) {
      return nativeRemoveNativeGlobalHandler(removedHandlerId);
    }
    return false;
  }

  private native boolean nativeRemoveNativeGlobalHandler(int handlerId);

  public void addMessageHandler(MessageHandler handler) {
    if (handler == null) {
      return;
    }
    nativeAddNativeMessageHandler(new MessageHandlerDelegate(handler));
  }

  private native void nativeAddNativeMessageHandler(MessageHandlerDelegate handler);

  public boolean removeMessageHandler(MessageHandler handler) {
    if (handler == null) {
      return false;
    }
    return nativeRemoveNativeMessageHandler(handler.getName());
  }

  private native boolean nativeRemoveNativeMessageHandler(String handlerName);

  public void addSessionHandler(DebugRouterSessionHandler handler) {
    if (handler == null) {
      return;
    }
    SessionHandlerDelegate currHandler = new SessionHandlerDelegate(handler);
    int handlerId = nativeAddNativeSessionHandler(currHandler);
    mSessionHandlers.put(handler, handlerId);
  }

  private native int nativeAddNativeSessionHandler(SessionHandlerDelegate handler);

  public boolean removeSessionHandler(DebugRouterSessionHandler handler) {
    if (handler == null) {
      return false;
    }
    Integer removedHandlerId = mSessionHandlers.remove(handler);
    if (removedHandlerId != null) {
      return nativeRemoveNativeSessionHandler(removedHandlerId);
    }
    return false;
  }

  private native boolean nativeRemoveNativeSessionHandler(int handlerId);

  @Deprecated
  public void connect(String url, String room) {
    LLog.i(TAG, "connect url:" + url + ", room:" + room);
    nativeConnect(url, room);
  }

  private native void nativeConnect(String url, String room);

  private native void nativeDisconnect();

  private native void nativeConnectAsync(String url, String room);

  private native void nativeDisconnectAsync();

  public int getSessionIdByView(@NonNull View view) {
    synchronized (viewMap) {
      Integer sessionId = viewMap.get(view);
      return sessionId == null ? 0 : sessionId;
    }
  }

  @Nullable
  public View getViewBySessionId(int sessionId) {
    synchronized (viewMap) {
      for (Map.Entry<View, Integer> entry : viewMap.entrySet()) {
        int viewSessionId = entry.getValue();
        if (viewSessionId == sessionId) {
          return entry.getKey();
        }
      }
      return null;
    }
  }

  public void setSessionIdOfView(@NonNull View view, int sessionId) {
    synchronized (viewMap) {
      viewMap.put(view, sessionId);
    }
  }

  @Deprecated
  public void disconnect() {
    LLog.i(TAG, "disconnect");
    nativeDisconnect();
  }

  public void connectAsync(String url, String room) {
    LLog.i(TAG, "connectAsync url:" + url + ", room:" + room);
    // TODO MonitorRunnable in C++
    nativeConnectAsync(url, room);
  }

  public void disconnectAsync() {
    // TODO MonitorRunnable in C++
    nativeDisconnectAsync();
  }

  private native int nativePlug(NativeSlotDelegate slot);

  public int plug(@NonNull DebugRouterSlot slot) {
    LLog.i(TAG, "plug session " + slot.getTemplateUrl());

    int sessionId = nativePlug(new NativeSlotDelegate(slot));
    View view = slot.getTemplateView();
    if (view != null) {
      synchronized (viewMap) {
        viewMap.put(view, sessionId);
      }
    }
    return sessionId;
  }

  private native void nativePull(int sessionId);

  public void pull(int sessionId) {
    LLog.i(TAG, "pull session " + sessionId);
    nativePull(sessionId);
  }

  private native void nativeSend(String message);

  public void send(String message) {
    if (message == null) {
      LLog.i(TAG, "send: message == null");
      return;
    }
    nativeSend(message);
  }

  public void sendData(String type, int session, String data) {
    sendData(type, session, data, -1);
  }

  public void sendData(String type, int session, String data, int mark) {
    sendData(type, session, data, mark, false);
  }

  public void sendData(String type, int session, JSONObject data) {
    sendData(type, session, data, -1);
  }

  public void sendData(String type, int session, JSONObject data, int mark) {
    sendData(type, session, data.toString(), mark, true);
  }

  private native void nativeSendData(
      String type, int session, String data, int mark, boolean isObject);

  private native void nativeSendDataAsync(
      String type, int session, String data, int mark, boolean isObject);

  private void sendData(String type, int session, String data, int mark, boolean isObject) {
    if (data == null) {
      LLog.i(TAG, "sendData: message == null");
      return;
    }
    nativeSendData(type, session, data, mark, isObject);
  }

  private native void nativeSendAsync(String message);

  public void sendAsync(String message) {
    nativeSendAsync(message);
  }

  public void sendDataAsync(String type, int session, String data) {
    sendDataAsync(type, session, data, -1);
  }

  public void sendDataAsync(String type, int session, String data, int mark) {
    nativeSendDataAsync(type, session, data, mark, false);
  }

  public void sendDataAsync(String type, int session, JSONObject data) {
    sendDataAsync(type, session, data, -1);
  }

  public void sendDataAsync(String type, int session, JSONObject data, int mark) {
    nativeSendDataAsync(type, session, data.toString(), mark, true);
  }

  private native boolean nativeIsValidSchema(String schema);

  public boolean isValidSchema(@NonNull String schema) {
    return nativeIsValidSchema(schema);
  }

  private native boolean nativeHandleSchema(String schema);

  public boolean handleSchema(@NonNull String schema) {
    DebugRouterReport.reportHandleSchema(schema);
    return nativeHandleSchema(schema);
  }

  private native void nativeAddStateListener(NativeStateListenerDelegate listener);

  public void addStateListener(StateListener listener) {
    if (listener != null) {
      nativeAddStateListener(new NativeStateListenerDelegate(listener));
    }
  }

  public String getVersion() {
    return BuildConfig.DEBUGROUTER_VERSION;
  }

  public static int getUSBPort() {
    return getInstance().nativeGetUSBPort();
  }

  private native int nativeGetConnectionState();

  // The connection status of DebugRouter can be obtained by listening to the status messages of
  // DebugRouter.
  @Deprecated
  public ConnectionState getConnectionState() {
    int state = nativeGetConnectionState();
    switch (state) {
      case -1:
        return ConnectionState.DISCONNECTED;
      case 1:
        return ConnectionState.CONNECTED;
      default:
        break;
    }
    return ConnectionState.DISCONNECTED;
  }

  // TODO thread safely
  private native int nativeGetUSBPort();

  private String checkNetworkStatus(Context context) {
    if (context == null) {
      return "";
    }
    ConnectivityManager cm =
        (ConnectivityManager) context.getSystemService(Context.CONNECTIVITY_SERVICE);
    if (cm == null || cm.getActiveNetworkInfo() == null) {
      return "";
    }
    return cm.getActiveNetworkInfo().getTypeName();
  }

  private String getCurrentProcessName() {
    String processName = "android";
    try {
      final Method declaredMethod =
          Class.forName("android.app.ActivityThread", false, Application.class.getClassLoader())
              .getDeclaredMethod("currentProcessName", (Class<?>[]) new Class[0]);
      declaredMethod.setAccessible(true);
      final Object invoke = declaredMethod.invoke(null, new Object[0]);
      if (invoke instanceof String) {
        processName = (String) invoke;
      }
    } catch (Throwable e) {
      e.printStackTrace();
    }
    return processName;
  }

  public void setConfig(@NonNull String configKey, @NonNull Boolean value) {
    nativeSetConfig(configKey, value.toString());
  }

  private native void nativeSetConfig(String configKey, String value);

  private native String nativeGetConfig(String configKey, String defaultValue);

  public Boolean getConfig(@NonNull String configKey, @NonNull Boolean defaultValue) {
    String value = nativeGetConfig(configKey, defaultValue.toString());
    if ("true".equals(value)) {
      return true;
    } else if ("false".equals(value)) {
      return false;
    }
    LLog.w(TAG, "getConfig: value is illegal");
    return false;
  }
}
