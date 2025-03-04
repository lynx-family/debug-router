// Copyright 2024 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

#include "debug_router_android.h"

#include <memory>

#include "debug_router/Android/build/gen/DebugRouter_jni.h"
#include "debug_router/native/android/base/android/jni_helper.h"
#include "debug_router/native/android/debug_router_global_handler_android.h"
#include "debug_router/native/android/debug_router_listener_android.h"
#include "debug_router/native/android/debug_router_session_handler_android.h"
#include "debug_router/native/android/message_handler_android.h"
#include "debug_router/native/android/native_slot_android.h"
#include "debug_router/native/core/debug_router_config.h"
#include "debug_router/native/core/debug_router_core.h"

void CreateDebugRouter(JNIEnv *env, jobject jcaller) {
  debugrouter::core::DebugRouterCore::GetInstance();
}

void Connect(JNIEnv *env, jobject jcaller, jstring url, jstring room) {
  debugrouter::core::DebugRouterCore::GetInstance().Connect(
      debugrouter::common::android::JNIHelper::ConvertToString(env, url),
      debugrouter::common::android::JNIHelper::ConvertToString(env, room));
}

void Disconnect(JNIEnv *env, jobject jcaller) {
  debugrouter::core::DebugRouterCore::GetInstance().Disconnect();
}

void ConnectAsync(JNIEnv *env, jobject jcaller, jstring url, jstring room) {
  debugrouter::core::DebugRouterCore::GetInstance().ConnectAsync(
      debugrouter::common::android::JNIHelper::ConvertToString(env, url),
      debugrouter::common::android::JNIHelper::ConvertToString(env, room));
}

jboolean IsValidSchema(JNIEnv *env, jobject jcaller, jstring schema) {
  return debugrouter::core::DebugRouterCore::GetInstance().IsValidSchema(
      debugrouter::common::android::JNIHelper::ConvertToString(env, schema));
}

void DisconnectAsync(JNIEnv *env, jobject jcaller) {
  debugrouter::core::DebugRouterCore::GetInstance().DisconnectAsync();
}

jint Plug(JNIEnv *env, jobject jcaller, jobject slot) {
  auto native_slot =
      std::make_shared<debugrouter::android::NativeSlotAndroid>(env, slot);
  return debugrouter::core::DebugRouterCore::GetInstance().Plug(native_slot);
}

void SetAppInfo(JNIEnv *env, jobject jcaller, jstring key, jstring value) {
  debugrouter::core::DebugRouterCore::GetInstance().SetAppInfo(
      debugrouter::common::android::JNIHelper::ConvertToString(env, key),
      debugrouter::common::android::JNIHelper::ConvertToString(env, value));
}

jstring GetAppInfoByKey(JNIEnv *env, jobject jcaller, jstring key) {
  std::string value =
      debugrouter::core::DebugRouterCore::GetInstance().GetAppInfoByKey(
          debugrouter::common::android::JNIHelper::ConvertToString(env, key));
  return debugrouter::common::android::JNIHelper::ConvertToJNIString(env,
                                                                     value);
}

void Pull(JNIEnv *env, jobject jcaller, jint sessionId) {
  debugrouter::core::DebugRouterCore::GetInstance().Pull(sessionId);
}

void Send(JNIEnv *env, jobject jcaller, jstring message) {
  debugrouter::core::DebugRouterCore::GetInstance().Send(
      debugrouter::common::android::JNIHelper::ConvertToString(env, message));
}

void SendData(JNIEnv *env, jobject jcaller, jstring type, jint session,
              jstring data, jint mark, jboolean isObject) {
  debugrouter::core::DebugRouterCore::GetInstance().SendData(
      debugrouter::common::android::JNIHelper::ConvertToString(env, data),
      debugrouter::common::android::JNIHelper::ConvertToString(env, type),
      session, mark, isObject);
}

void SendDataAsync(JNIEnv *env, jobject jcaller, jstring type, jint session,
                   jstring data, jint mark, jboolean isObject) {
  debugrouter::core::DebugRouterCore::GetInstance().SendDataAsync(
      debugrouter::common::android::JNIHelper::ConvertToString(env, data),
      debugrouter::common::android::JNIHelper::ConvertToString(env, type),
      session, mark, isObject);
}

void SendAsync(JNIEnv *env, jobject jcaller, jstring message) {
  debugrouter::core::DebugRouterCore::GetInstance().SendAsync(
      debugrouter::common::android::JNIHelper::ConvertToString(env, message));
}

void AddStateListener(JNIEnv *env, jobject jcaller, jobject listener) {
  debugrouter::core::DebugRouterCore::GetInstance().AddStateListener(
      std::make_shared<debugrouter::android::DebugRouterListenerAndroid>(
          env, listener));
}

jint GetUSBPort(JNIEnv *env, jobject jcaller) {
  return debugrouter::core::DebugRouterCore::GetInstance().GetUSBPort();
}

void SetConfig(JNIEnv *env, jobject jcaller, jstring configKey, jstring value) {
  debugrouter::core::DebugRouterConfigs::GetInstance().SetConfig(
      debugrouter::common::android::JNIHelper::ConvertToString(env, configKey),
      debugrouter::common::android::JNIHelper::ConvertToString(env, value));
}

jint AddNativeGlobalHandler(JNIEnv *env, jobject jcaller, jobject handler) {
  return debugrouter::core::DebugRouterCore::GetInstance().AddGlobalHandler(
      new debugrouter::android::DebugRouterGlobalHandlerAndroid(env, handler));
}

jboolean RemoveNativeGlobalHandler(JNIEnv *env, jobject jcaller,
                                   jint handler_id) {
  return debugrouter::core::DebugRouterCore::GetInstance().RemoveGlobalHandler(
      handler_id);
}

void AddNativeMessageHandler(JNIEnv *env, jobject jcaller, jobject handler) {
  debugrouter::core::DebugRouterCore::GetInstance().AddMessageHandler(
      new debugrouter::android::MessageHandlerAndroid(env, handler));
}

jboolean RemoveNativeMessageHandler(JNIEnv *env, jobject jcaller,
                                    jstring handler_name) {
  return debugrouter::core::DebugRouterCore::GetInstance().RemoveMessageHandler(
      debugrouter::common::android::JNIHelper::ConvertToString(env,
                                                               handler_name));
}

jint AddNativeSessionHandler(JNIEnv *env, jobject jcaller, jobject handler) {
  return debugrouter::core::DebugRouterCore::GetInstance().AddSessionHandler(
      new debugrouter::android::DebugRouterSessionHandlerAndroid(env, handler));
}

jboolean RemoveNativeSessionHandler(JNIEnv *env, jobject jcaller,
                                    jint handler_id) {
  return debugrouter::core::DebugRouterCore::GetInstance().RemoveSessionHandler(
      handler_id);
}

static jstring GetConfig(JNIEnv *env, jobject jcaller, jstring configKey,
                         jstring defaultValue) {
  return debugrouter::common::android::JNIHelper::ConvertToJNIString(
      env, debugrouter::core::DebugRouterConfigs::GetInstance().GetConfig(
               debugrouter::common::android::JNIHelper::ConvertToString(
                   env, configKey),
               debugrouter::common::android::JNIHelper::ConvertToString(
                   env, defaultValue)));
}

static jint GetConnectionState(JNIEnv *env, jobject jcaller) {
  return debugrouter::core::DebugRouterCore::GetInstance().GetConnectionState();
}

jboolean HandleSchema(JNIEnv *env, jobject jcaller, jstring schema) {
  return debugrouter::core::DebugRouterCore::GetInstance().HandleSchema(
      debugrouter::common::android::JNIHelper::ConvertToString(env, schema));
}

jstring GetRoomId(JNIEnv *env, jobject jcaller) {
  return debugrouter::common::android::JNIHelper::ConvertToJNIString(
      env, debugrouter::core::DebugRouterCore::GetInstance().GetRoomId());
}

jstring GetServerUrl(JNIEnv *env, jobject jcaller) {
  return debugrouter::common::android::JNIHelper::ConvertToJNIString(
      env, debugrouter::core::DebugRouterCore::GetInstance().GetServerUrl());
}

namespace debugrouter {
namespace android {

bool DebugRouterAndroid::RegisterJNIUtils(JNIEnv *env) {
  return RegisterNativesImpl(env);
}
}  // namespace android
};  // namespace debugrouter
