// Copyright 2024 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

package com.lynx.debugrouter.testapp;

import android.content.Context;
import android.content.Intent;
import android.os.Bundle;
import android.os.Handler;
import android.os.StrictMode;
import android.widget.Toast;
import androidx.appcompat.app.AppCompatActivity;
import com.lynx.debugrouter.ConnectionType;
import com.lynx.debugrouter.DebugRouter;
import com.lynx.debugrouter.DebugRouterSessionHandler;
import com.lynx.debugrouter.DebugRouterSlot;
import com.lynx.debugrouter.DebugRouterSlotDelegate;
import com.lynx.debugrouter.StateListener;
import com.lynx.debugrouter.log.LLog;

public class MainActivity extends AppCompatActivity implements StateListener {
  private static final String TAG = "MainActivity";

  @Override
  protected void onCreate(Bundle savedInstanceState) {
    super.onCreate(savedInstanceState);
    setContentView(R.layout.activity_main);
    StrictMode.ThreadPolicy policy = new StrictMode.ThreadPolicy.Builder().permitAll().build();
    StrictMode.setThreadPolicy(policy);
    DebugRouter.getInstance();

    testAddSessionHandlerJNI();

    Intent intent = getIntent();
    String type = intent.getStringExtra("connection_type");
    if (type == null) {
      String errorMsg = "connection_type == null";
      LLog.e(TAG, errorMsg);
      Toast.makeText(this, errorMsg, Toast.LENGTH_LONG).show();
      return;
    }
    switch (type) {
      case "websocket":
        handleWebSocket(intent);
        break;
      case "usb":
        handleUsb(intent);
        break;
      default:
        String errorMsg = "unknown connection_type:" + type;
        LLog.e(TAG, errorMsg);
        Toast.makeText(this, errorMsg, Toast.LENGTH_LONG).show();
    }
  }

  private void testAddSessionHandlerJNI() {
    DebugRouter.getInstance().addSessionHandler(new DebugRouterSessionHandler() {
      @Override
      public void onSessionCreate(int sessionId, String url) {
        LLog.i(TAG, "onSessionCreate:" + sessionId + url);
      }
      @Override
      public void onSessionDestroy(int sessionId) {
        LLog.i(TAG, "onSessionDestroy:" + sessionId);
      }
      @Override
      public void onMessage(String message, String type, int sessionId) {
        LLog.i(TAG, "onMessage:" + message + type + sessionId);
      }
    });

    DebugRouter.getInstance().plug(new DebugRouterSlot(new DebugRouterSlotDelegate() {
      @Override
      public String getTemplateUrl() {
        return "templateUrl";
      }
      @Override
      public void onMessage(String type, String message) {
        LLog.i(TAG, "onMessage:" + type + message);
      }
    }));
  }

  private void handleUsb(Intent intent) {
    int usbPort = DebugRouter.getUSBPort();
    LLog.i(TAG, "handleUsb: usb_port" + usbPort);
    Toast.makeText(this, "usb:" + usbPort, Toast.LENGTH_LONG).show();
    DebugRouter.getInstance().addStateListener(this);
  }

  private void handleWebSocket(Intent intent) {
    String url = intent.getStringExtra("websocket_schema");
    if (url == null || url.isEmpty()) {
      LLog.e(TAG, "url is illegal:" + url);
      return;
    }
    LLog.i(TAG, "handleSchema url:" + url);
    DebugRouter debugRouter = DebugRouter.getInstance();
    debugRouter.addStateListener(this);
    boolean result = debugRouter.handleSchema(url);
    LLog.i(TAG, "handleSchema result:" + result);
    Toast.makeText(this, result + ":" + url, Toast.LENGTH_LONG).show();
  }

  @Override
  public void onOpen(ConnectionType type) {
    LLog.i(TAG, "MainActivity stateListener onOpen.");
    LLog.i(TAG, "ServerUrl:" + DebugRouter.getInstance().getServerUrl());
  }

  @Override
  public void onClose(int code, String reason) {
    LLog.e(TAG, "onClose:" + code + reason);
  }

  @Override
  public void onMessage(String text) {
    LLog.i(TAG, "onMessage:" + text);
    // {"event":"Customized","data":{"type":"Hello1","data":{"client_id":2},"sender":1},"to":2}
    if (text.contains("Hello1")) {
      DebugRouter.getInstance().sendData("Hello2", -1, "");
    }
  }

  @Override
  public void onError(String error) {
    LLog.e(TAG, "onError:" + error);
  }
}
