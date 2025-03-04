// Copyright 2024 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

#ifndef DEBUGROUTER_NATIVE_ANDROID_DEBUG_ROUTER_GLOBAL_HANDLER_ANDROID_H_
#define DEBUGROUTER_NATIVE_ANDROID_DEBUG_ROUTER_GLOBAL_HANDLER_ANDROID_H_

#include <jni.h>

#include "debug_router/native/android/base/android/scoped_java_ref.h"
#include "debug_router/native/core/debug_router_global_handler.h"

namespace debugrouter {
namespace android {

class DebugRouterGlobalHandlerAndroid
    : public debugrouter::core::DebugRouterGlobalHandler {
 public:
  static bool RegisterJNIUtils(JNIEnv *env);
  DebugRouterGlobalHandlerAndroid(JNIEnv *env, jobject handler);
  virtual void OpenCard(const std::string &url) override;
  virtual void OnMessage(const std::string &message,
                         const std::string &type) override;

 private:
  std::unique_ptr<debugrouter::common::android::ScopedGlobalJavaRef<jobject>>
      handler_ptr_;
};

}  // namespace android
}  // namespace debugrouter

#endif  // DEBUGROUTER_NATIVE_ANDROID_GLOBAL_HANDLER_ANDROID_H_
