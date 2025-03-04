// Copyright 2024 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

#include "debug_router/native/android/message_handler_android.h"

#include "debug_router/Android/build/gen/MessageHandlerDelegate_jni.h"
#include "debug_router/native/android/base/android/jni_helper.h"

namespace debugrouter {
namespace android {

MessageHandlerAndroid::MessageHandlerAndroid(JNIEnv *env, jobject handler)
    : handler_ptr_(std::make_unique<
                   debugrouter::common::android::ScopedGlobalJavaRef<jobject>>(
          env, handler)) {}

std::string MessageHandlerAndroid::Handle(std::string params) {
  JNIEnv *env = debugrouter::common::android::AttachCurrentThread();
  return debugrouter::common::android::JNIHelper::ConvertToString(
      env, Java_MessageHandlerDelegate_handleAppAction(
               env, handler_ptr_->Get(),
               debugrouter::common::android::JNIHelper::ConvertToJNIStringRef(
                   env, params)
                   .Get())
               .Get());
}

/**
 * MessageHandler's name
 *
 * Unique identifier for the MessageHandler.
 *
 * It indicates which messages this handler can process.
 */
std::string MessageHandlerAndroid::GetName() const {
  JNIEnv *env = debugrouter::common::android::AttachCurrentThread();
  return debugrouter::common::android::JNIHelper::ConvertToString(
      env, Java_MessageHandlerDelegate_getName(env, handler_ptr_->Get()).Get());
}

bool MessageHandlerAndroid::RegisterJNIUtils(JNIEnv *env) {
  return RegisterNativesImpl(env);
}

}  // namespace android
}  // namespace debugrouter
