// Copyright 2024 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

package com.lynx.debugrouter;

import android.text.TextUtils;
import androidx.annotation.Nullable;
import com.lynx.debugrouter.base.CalledByNative;
import com.lynx.debugrouter.base.MessageTransceiver;
import com.lynx.debugrouter.base.MessageTransceiverStateListener;
import com.lynx.debugrouter.log.LLog;
import java.net.URI;
import java.net.URISyntaxException;
import java.util.Locale;
import java.util.concurrent.TimeUnit;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;
import okhttp3.WebSocket;
import okhttp3.WebSocketListener;
import okio.ByteString;

public class WebSocketClient extends WebSocketListener implements MessageTransceiver {
  private static final String TAG = "WebSocketClient";
  private static final int MAX_LOG_LENGTH = 10240;

  private volatile WebSocket mWebSocket;

  private OkHttpClient mClient = new OkHttpClient.Builder()
                                     .pingInterval(5, TimeUnit.SECONDS)
                                     .connectTimeout(5, TimeUnit.SECONDS)
                                     .readTimeout(30, TimeUnit.SECONDS)
                                     .writeTimeout(30, TimeUnit.SECONDS)
                                     .build();

  private MessageTransceiverStateListener mStateListener;

  public WebSocketClient() {}

  @Override
  public boolean connect(String url) {
    LLog.d(TAG, "connect " + url);
    String host = "";
    int port = 80;
    try {
      URI uri = new URI(url);
      host = uri.getHost();
      port = uri.getPort();
      if (port == -1) {
        String scheme = uri.getScheme().toLowerCase(Locale.US);
        port = (TextUtils.equals(scheme, "wss") ? 443 : 80);
      }
    } catch (URISyntaxException e) {
      e.printStackTrace();
    }

    Request request = new Request.Builder()
                          .url(url)
                          .addHeader("Upgrade", "WebSocket")
                          .addHeader("Connection", "Upgrade")
                          .addHeader("Sec-WebSocket-Key", "J4axdrB5EVmab8YnJ4z3bw==")
                          .addHeader("Sec-WebSocket-Version", "13")
                          .addHeader("Host", host + ":" + port)
                          .build();
    mWebSocket = mClient.newWebSocket(request, this);
    return true;
  }

  @Override
  public void send(String text) {
    if (mWebSocket != null && text != null) {
      if (text.length() < MAX_LOG_LENGTH) {
        LLog.d(TAG, "send: " + text);
      } else {
        int indexOfComma = text.indexOf(",");
        LLog.d(TAG, "send: " + text.substring(0, indexOfComma > 0 ? indexOfComma : 200) + "...");
      }
      mWebSocket.send(text);
    }
  }

  @Override
  public void disconnect() {
    if (mWebSocket != null) {
      mWebSocket.close(1000, null);
      mWebSocket = null;
    }
  }

  @Override
  public void setStateListener(MessageTransceiverStateListener listener) {
    mStateListener = listener;
  }

  @Override
  public void removeStateListener(MessageTransceiverStateListener listener) {
    mStateListener = null;
  }

  @Override
  public void onOpen(WebSocket webSocket, Response response) {
    super.onOpen(webSocket, response);
    LLog.i(TAG, "onOpen");
    if (mStateListener != null) {
      mStateListener.onOpen(this);
    }
  }

  @Override
  public void onMessage(WebSocket webSocket, String text) {
    super.onMessage(webSocket, text);
    if (text.length() < MAX_LOG_LENGTH) {
      LLog.d(TAG, "onMessage: " + text);
    } else {
      int indexOfComma = text.indexOf(",");
      LLog.d(TAG, "onMessage: " + text.substring(0, indexOfComma > 0 ? indexOfComma : 200) + "...");
    }
    if (mStateListener != null) {
      mStateListener.onMessage(this, text);
    }
  }

  @Override
  public void onMessage(WebSocket webSocket, ByteString bytes) {
    super.onMessage(webSocket, bytes);
  }

  @Override
  public void onClosing(WebSocket webSocket, int code, String reason) {
    super.onClosing(webSocket, code, reason);
    LLog.i(TAG, "onClosing");
  }

  @Override
  public void onClosed(WebSocket webSocket, int code, String reason) {
    super.onClosed(webSocket, code, reason);
    LLog.i(TAG, "onClosed, code: " + code + ", reason: " + reason);
    if (mStateListener != null) {
      mStateListener.onClose(this, code, reason);
    }
  }

  @Override
  public void onFailure(WebSocket webSocket, Throwable t, @Nullable Response response) {
    super.onFailure(webSocket, t, response);
    LLog.i(TAG, "onError: " + t.toString());
    if (mStateListener != null) {
      mStateListener.onError(this, t);
    }
  }

  @Override
  public long queueSize() {
    return mWebSocket != null ? mWebSocket.queueSize() : 0;
  }
}
