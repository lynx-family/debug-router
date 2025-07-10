// Copyright 2024 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

#include "debug_router/native/android/debug_router_listener_android.h"

#include "debug_router/android/build/gen/NativeStateListenerDelegate_jni.h"
#include "debug_router/native/android/base/android/jni_helper.h"
#include "debug_router/native/core/debug_router_state_listener.h"

namespace debugrouter {
namespace android {

DebugRouterListenerAndroid::DebugRouterListenerAndroid(JNIEnv *env,
                                                       jobject listener)
    : listener_ptr_(std::make_unique<
                    debugrouter::common::android::ScopedGlobalJavaRef<jobject>>(
          env, listener)) {}

void DebugRouterListenerAndroid::OnOpen(core::ConnectionType type) {
  JNIEnv *env = debugrouter::common::android::AttachCurrentThread();

  Java_NativeStateListenerDelegate_onOpen(
      env, listener_ptr_->Get(),
      debugrouter::common::android::JNIHelper::ConvertToJNIStringRef(
          env, core::ConnectionTypes[type])
          .Get());
}
void DebugRouterListenerAndroid::OnClose(int32_t code,
                                         const std::string &reason) {
  JNIEnv *env = debugrouter::common::android::AttachCurrentThread();

  Java_NativeStateListenerDelegate_onClose(
      env, listener_ptr_->Get(), code,
      debugrouter::common::android::JNIHelper::ConvertToJNIStringRef(env,
                                                                     reason)
          .Get());
}
void DebugRouterListenerAndroid::OnMessage(const std::string &message) {
  JNIEnv *env = debugrouter::common::android::AttachCurrentThread();

  Java_NativeStateListenerDelegate_onMessage(
      env, listener_ptr_->Get(),
      debugrouter::common::android::JNIHelper::ConvertToJNIStringRef(env,
                                                                     message)
          .Get());
}
void DebugRouterListenerAndroid::OnError(const std::string &error) {
  JNIEnv *env = debugrouter::common::android::AttachCurrentThread();

  Java_NativeStateListenerDelegate_onError(
      env, listener_ptr_->Get(),
      debugrouter::common::android::JNIHelper::ConvertToJNIStringRef(env, error)
          .Get());
}
bool DebugRouterListenerAndroid::RegisterJNIUtils(JNIEnv *env) {
  return RegisterNativesImpl(env);
}

}  // namespace android
}  // namespace debugrouter
