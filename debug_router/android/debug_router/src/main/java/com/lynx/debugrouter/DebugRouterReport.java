// Copyright 2023 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

package com.lynx.debugrouter;

import com.lynx.debugrouter.base.MessageTransceiver;
import com.lynx.debugrouter.base.NativeMessageTransceiver;
import com.lynx.debugrouter.base.report.DebugRouterReportServiceUtil;
import com.lynx.debugrouter.log.LLog;
import org.json.JSONException;
import org.json.JSONObject;

public class DebugRouterReport {
  private static final String TAG = "DebugRouterReport";
  public static void reportOnOpenWarning(MessageTransceiver transceiver) {
    JSONObject jsonObject = new JSONObject();
    try {
      jsonObject.put("connect_type", getTransceiverType(transceiver));
    } catch (JSONException e) {
      LLog.e(TAG, "reportOnOpenWarning:" + e.toString());
    }
    DebugRouterReportServiceUtil.report("similar_trans_open", jsonObject, null, null);
  }

  public static void reportOnOpen(MessageTransceiver transceiver) {
    JSONObject jsonObject = new JSONObject();
    try {
      jsonObject.put("connect_type", getTransceiverType(transceiver));
    } catch (JSONException e) {
      LLog.e(TAG, "reportOnOpen:" + e.toString());
    }
    DebugRouterReportServiceUtil.report("onOpen", jsonObject, null, null);
  }

  public static void reportOnClose(MessageTransceiver transceiver, int code, String reason) {
    JSONObject jsonObject = new JSONObject();
    try {
      jsonObject.put("connect_type", getTransceiverType(transceiver));
      jsonObject.put("code", String.valueOf(code));
      jsonObject.put("message", reason);
    } catch (JSONException e) {
      LLog.e(TAG, "reportOnClose:" + e.toString());
    }
    DebugRouterReportServiceUtil.report("onClose", jsonObject, null, null);
  }

  public static void reportOnCloseWarning(MessageTransceiver transceiver,
      MessageTransceiver mCurrentTransceiver, ConnectionState mConnectionState) {
    JSONObject jsonObject = new JSONObject();
    String msg = "";
    if (transceiver != mCurrentTransceiver) {
      msg = "different transceiver when close";
    } else if (mConnectionState == ConnectionState.DISCONNECTED) {
      msg = "ConnectionState is DISCONNECTED when close";
    }
    try {
      jsonObject.put("connect_type", getTransceiverType(mCurrentTransceiver));
      jsonObject.put("warning_msg", msg);
    } catch (JSONException e) {
      LLog.e(TAG, "reportOnCloseWarning:" + e.toString());
    }
    DebugRouterReportServiceUtil.report("OnCloseWarning", jsonObject, null, null);
  }

  public static void reportDurTime(MessageTransceiver transceiver, long duration, String reason) {
    JSONObject jsonObjectMetric = new JSONObject();
    JSONObject jsonObjectCategory = new JSONObject();
    try {
      jsonObjectMetric.put("duration", duration);
      jsonObjectCategory.put("Transceiver", getTransceiverType(transceiver));
      jsonObjectCategory.put("reason", reason);
    } catch (JSONException e) {
      LLog.e(TAG, "reportDurTime:" + e.toString());
    }
    DebugRouterReportServiceUtil.report(
        "TransceiverTime", jsonObjectCategory, jsonObjectMetric, null);
  }

  public static void reportDurTimeError(MessageTransceiver transceiver, String reason) {
    JSONObject jsonObjectCategory = new JSONObject();
    try {
      jsonObjectCategory.put("Transceiver", getTransceiverType(transceiver));
      jsonObjectCategory.put("reason", reason);
    } catch (JSONException e) {
      LLog.e(TAG, "reportDurTimeError:" + e.toString());
    }
    DebugRouterReportServiceUtil.report("TransceiverTimeError", jsonObjectCategory, null, null);
  }

  public static void reportOnMessageWarning(
      MessageTransceiver transceiver, MessageTransceiver mCurrentTransceiver, String message) {
    JSONObject jsonObject = new JSONObject();
    try {
      jsonObject.put("msg", message.substring(0, Math.min(512, message.length())));
      jsonObject.put("CurrentTransceiver", getTransceiverType(mCurrentTransceiver));
      jsonObject.put("Transceiver", getTransceiverType(transceiver));
    } catch (JSONException e) {
      LLog.e(TAG, "reportOnMessageWarning:" + e.toString());
    }
    DebugRouterReportServiceUtil.report("OnMessageWarning", jsonObject, null, null);
  }

  public static void reportReceiveMessage(String message, MessageTransceiver transceiver) {
    JSONObject jsonObject = new JSONObject();
    try {
      jsonObject.put("msg", message.substring(0, Math.min(512, message.length())));
      jsonObject.put("connect_type", getTransceiverType(transceiver));
    } catch (JSONException e) {
      LLog.e(TAG, "reportReceiveMessage:" + e.toString());
    }
    DebugRouterReportServiceUtil.report("receive_message", jsonObject, null, null);
  }

  public static void reportSendMessage(String message) {
    JSONObject jsonObject = new JSONObject();
    try {
      jsonObject.put("msg", message.substring(0, Math.min(512, message.length())));
    } catch (JSONException e) {
      throw new RuntimeException(e);
    }
    DebugRouterReportServiceUtil.report("SendMessage", jsonObject, null, null);
  }

  public static void reportOnError(MessageTransceiver transceiver, String errorMsg) {
    JSONObject jsonObject = new JSONObject();
    try {
      jsonObject.put("connect_type", getTransceiverType(transceiver));
      jsonObject.put("error_msg", errorMsg);
    } catch (JSONException e) {
      LLog.e(TAG, "reportOnError:" + e.toString());
    }
    DebugRouterReportServiceUtil.report("onError", jsonObject, null, null);
  }

  public static void reportHandleSchema(String schema) {
    JSONObject jsonObject = new JSONObject();
    try {
      jsonObject.put("schema", schema);
    } catch (JSONException e) {
      LLog.e(TAG, "reportHandleSchema:" + e.toString());
    }
    DebugRouterReportServiceUtil.report("handleSchema", jsonObject, null, null);
  }

  public static void reportConnect(String url, String room, boolean isReconnect) {
    JSONObject jsonObject = new JSONObject();
    try {
      jsonObject.put("url", url);
      jsonObject.put("room", room);
    } catch (JSONException e) {
      LLog.e(TAG, "reportConnect:" + e.toString());
    }
    if (isReconnect) {
      DebugRouterReportServiceUtil.report("reconnect", jsonObject, null, null);
    } else {
      DebugRouterReportServiceUtil.report("connect", jsonObject, null, null);
    }
  }

  public static void reportNewSocketClient(String address) {
    JSONObject jsonObject = new JSONObject();
    try {
      jsonObject.put("client", address);
    } catch (JSONException e) {
      LLog.e(TAG, "reportNewSocketClient:" + e.toString());
    }
    DebugRouterReportServiceUtil.report("new_socket_client", jsonObject, null, null);
  }

  public static void reportNewUSBClient(String address) {
    JSONObject jsonObject = new JSONObject();
    try {
      jsonObject.put("client", address);
    } catch (JSONException e) {
      LLog.e(TAG, "reportNewUSBClient:" + e.toString());
    }
    DebugRouterReportServiceUtil.report("new_usb_client", jsonObject, null, null);
  }

  public static void reportInitServerOK(int port) {
    JSONObject jsonObject = new JSONObject();
    try {
      jsonObject.put("port", port);
    } catch (JSONException e) {
      LLog.e(TAG, "reportInitServerOK:" + e.toString());
    }
    DebugRouterReportServiceUtil.report("USBServerInitOK", jsonObject, null, null);
  }

  public static void reportInValidClient(String address, String headerString) {
    JSONObject jsonObject = new JSONObject();
    try {
      jsonObject.put("address", address);
      jsonObject.put("header", headerString);
    } catch (JSONException e) {
      LLog.e(TAG, "reportInValidClient:" + e.toString());
    }
    DebugRouterReportServiceUtil.report("invalid_client", jsonObject, null, null);
  }

  private static String getTransceiverType(MessageTransceiver transceiver) {
    if (transceiver instanceof WebSocketClient) {
      return "OKHttp";
    }
    if (transceiver instanceof NativeMessageTransceiver) {
      return "NativeMessageTransceiver";
    }
    return "null";
  }
}
