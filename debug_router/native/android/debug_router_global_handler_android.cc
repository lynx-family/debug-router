// Copyright 2024 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

#include "debug_router/native/android/debug_router_global_handler_android.h"

#include "debug_router/Android/build/gen/GlobalHandlerDelegate_jni.h"
#include "debug_router/native/android/base/android/android_jni.h"
#include "debug_router/native/android/base/android/jni_helper.h"

namespace debugrouter {
namespace android {

DebugRouterGlobalHandlerAndroid::DebugRouterGlobalHandlerAndroid(
    JNIEnv *env, jobject handler)
    : handler_ptr_(std::make_unique<
                   debugrouter::common::android::ScopedGlobalJavaRef<jobject>>(
          env, handler)) {}

void DebugRouterGlobalHandlerAndroid::OpenCard(const std::string &url) {
  JNIEnv *env = debugrouter::common::android::AttachCurrentThread();
  Java_GlobalHandlerDelegate_openCard(
      env, handler_ptr_->Get(),
      debugrouter::common::android::JNIHelper::ConvertToJNIStringRef(env, url)
          .Get());
}
void DebugRouterGlobalHandlerAndroid::OnMessage(const std::string &message,
                                                const std::string &type) {
  JNIEnv *env = debugrouter::common::android::AttachCurrentThread();
  Java_GlobalHandlerDelegate_onMessage(
      env, handler_ptr_->Get(),
      debugrouter::common::android::JNIHelper::ConvertToJNIStringRef(env, type)
          .Get(),
      -1,
      debugrouter::common::android::JNIHelper::ConvertToJNIStringRef(env,
                                                                     message)
          .Get());
}

bool DebugRouterGlobalHandlerAndroid::RegisterJNIUtils(JNIEnv *env) {
  return RegisterNativesImpl(env);
}

}  // namespace android
}  // namespace debugrouter
