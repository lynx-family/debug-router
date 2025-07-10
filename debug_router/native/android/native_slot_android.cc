// Copyright 2024 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

#include "debug_router/native/android/native_slot_android.h"

#include "debug_router/android/build/gen/NativeSlotDelegate_jni.h"
#include "debug_router/native/android/base/android/jni_helper.h"

namespace debugrouter {
namespace android {

NativeSlotAndroid::NativeSlotAndroid(JNIEnv *env, jobject slot)
    : NativeSlot(debugrouter::common::android::JNIHelper::ConvertToString(
                     env, Java_NativeSlotDelegate_getType(env, slot).Get()),
                 debugrouter::common::android::JNIHelper::ConvertToString(
                     env, Java_NativeSlotDelegate_getUrl(env, slot).Get())),
      jobj_ptr_(std::make_unique<
                debugrouter::common::android::ScopedGlobalJavaRef<jobject>>(
          env, slot)) {}

void NativeSlotAndroid::OnMessage(const std::string &message,
                                  const std::string &type) {
  JNIEnv *env = debugrouter::common::android::AttachCurrentThread();
  Java_NativeSlotDelegate_onMessage(
      env, jobj_ptr_->Get(),
      debugrouter::common::android::JNIHelper::ConvertToJNIStringRef(env, type)
          .Get(),
      debugrouter::common::android::JNIHelper::ConvertToJNIStringRef(env,
                                                                     message)
          .Get());
}

bool NativeSlotAndroid::RegisterJNIUtils(JNIEnv *env) {
  return RegisterNativesImpl(env);
}

}  // namespace android
}  // namespace debugrouter
