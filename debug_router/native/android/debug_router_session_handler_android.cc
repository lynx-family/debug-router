// Copyright 2024 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

#include "debug_router/native/android/debug_router_session_handler_android.h"

#include "debug_router/Android/build/gen/SessionHandlerDelegate_jni.h"
#include "debug_router/native/android/base/android/android_jni.h"
#include "debug_router/native/android/base/android/jni_helper.h"

namespace debugrouter {
namespace android {

DebugRouterSessionHandlerAndroid::DebugRouterSessionHandlerAndroid(
    JNIEnv *env, jobject handler)
    : handler_ptr_(std::make_unique<
                   debugrouter::common::android::ScopedGlobalJavaRef<jobject>>(
          env, handler)) {}

void DebugRouterSessionHandlerAndroid::OnSessionCreate(int session_id,
                                                       const std::string &url) {
  JNIEnv *env = debugrouter::common::android::AttachCurrentThread();
  Java_SessionHandlerDelegate_onSessionCreate(
      env, handler_ptr_->Get(), session_id,
      debugrouter::common::android::JNIHelper::ConvertToJNIStringRef(env, url)
          .Get());
}

void DebugRouterSessionHandlerAndroid::OnSessionDestroy(int session_id) {
  JNIEnv *env = debugrouter::common::android::AttachCurrentThread();
  Java_SessionHandlerDelegate_onSessionDestroy(env, handler_ptr_->Get(),
                                               session_id);
}

void DebugRouterSessionHandlerAndroid::OnMessage(const std::string &message,
                                                 const std::string &type,
                                                 int session_id) {
  JNIEnv *env = debugrouter::common::android::AttachCurrentThread();
  Java_SessionHandlerDelegate_onMessage(
      env, handler_ptr_->Get(),
      debugrouter::common::android::JNIHelper::ConvertToJNIStringRef(env, type)
          .Get(),
      debugrouter::common::android::JNIHelper::ConvertToJNIStringRef(env,
                                                                     message)
          .Get(),
      session_id);
}

bool DebugRouterSessionHandlerAndroid::RegisterJNIUtils(JNIEnv *env) {
  return RegisterNativesImpl(env);
}

}  // namespace android
}  // namespace debugrouter
