// Copyright 2024 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

#include "debug_router/native/android/debug_router_target_handler_android.h"

#include "debug_router/android/build/gen/SessionHandlerDelegate_jni.h"
#include "debug_router/native/android/base/android/android_jni.h"
#include "debug_router/native/android/base/android/jni_helper.h"

namespace debugrouter {
namespace android {

DebugRouterTargetHandlerAndroid::DebugRouterTargetHandlerAndroid(
    JNIEnv *env, jobject handler)
    : handler_ptr_(std::make_unique<
                   debugrouter::common::android::ScopedGlobalJavaRef<jobject>>(
          env, handler)) {}

void DebugRouterTargetHandlerAndroid::OnTargetCreate(int target_id,
                                                     const std::string &url) {
  JNIEnv *env = debugrouter::common::android::AttachCurrentThread();
  Java_SessionHandlerDelegate_onSessionCreate(
      env, handler_ptr_->Get(), target_id,
      debugrouter::common::android::JNIHelper::ConvertToJNIStringRef(env, url)
          .Get());
}

void DebugRouterTargetHandlerAndroid::OnTargetDestroy(int target_id) {
  JNIEnv *env = debugrouter::common::android::AttachCurrentThread();
  Java_SessionHandlerDelegate_onSessionDestroy(env, handler_ptr_->Get(),
                                               target_id);
}

void DebugRouterTargetHandlerAndroid::OnMessage(const std::string &message,
                                                const std::string &type,
                                                int target_id) {
  JNIEnv *env = debugrouter::common::android::AttachCurrentThread();
  Java_SessionHandlerDelegate_onMessage(
      env, handler_ptr_->Get(),
      debugrouter::common::android::JNIHelper::ConvertToJNIStringRef(env, type)
          .Get(),
      debugrouter::common::android::JNIHelper::ConvertToJNIStringRef(env,
                                                                     message)
          .Get(),
      target_id);
}

bool DebugRouterTargetHandlerAndroid::RegisterJNIUtils(JNIEnv *env) {
  return RegisterNativesImpl(env);
}

}  // namespace android
}  // namespace debugrouter
