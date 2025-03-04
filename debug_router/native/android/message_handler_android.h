// Copyright 2024 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

#ifndef DEBUGROUTER_NATIVE_ANDROID_MESSAGE_HANDLER_ANDROID_H_
#define DEBUGROUTER_NATIVE_ANDROID_MESSAGE_HANDLER_ANDROID_H_

#include <jni.h>

#include "debug_router/native/android/base/android/scoped_java_ref.h"
#include "debug_router/native/core/debug_router_message_handler.h"

namespace debugrouter {
namespace android {

class MessageHandlerAndroid
    : public debugrouter::core::DebugRouterMessageHandler {
 public:
  static bool RegisterJNIUtils(JNIEnv *env);
  MessageHandlerAndroid(JNIEnv *env, jobject handler);
  virtual std::string Handle(std::string params) override;

  /**
   * MessageHandler's name
   *
   * Unique identifier for the MessageHandler.
   *
   * It indicates which messages this handler can process.
   */
  virtual std::string GetName() const override;

 private:
  std::unique_ptr<debugrouter::common::android::ScopedGlobalJavaRef<jobject>>
      handler_ptr_;
};

}  // namespace android
}  // namespace debugrouter

#endif  // DEBUGROUTER_NATIVE_ANDROID_MESSAGE_HANDLER_ANDROID_H_
