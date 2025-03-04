// Copyright 2024 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

#ifndef DEBUGROUTER_NATIVE_ANDROID_DEBUG_ROUTER_SESSION_HANDLER_ANDROID_H_
#define DEBUGROUTER_NATIVE_ANDROID_DEBUG_ROUTER_SESSION_HANDLER_ANDROID_H_

#include <jni.h>

#include "debug_router/native/android/base/android/scoped_java_ref.h"
#include "debug_router/native/core/debug_router_session_handler.h"

namespace debugrouter {
namespace android {

class DebugRouterSessionHandlerAndroid
    : public debugrouter::core::DebugRouterSessionHandler {
 public:
  static bool RegisterJNIUtils(JNIEnv *env);
  DebugRouterSessionHandlerAndroid(JNIEnv *env, jobject handler);
  virtual void OnSessionCreate(int session_id, const std::string &url) override;
  virtual void OnSessionDestroy(int session_id) override;
  virtual void OnMessage(const std::string &message, const std::string &type,
                         int session_id) override;

 private:
  std::unique_ptr<debugrouter::common::android::ScopedGlobalJavaRef<jobject>>
      handler_ptr_;
};

}  // namespace android
}  // namespace debugrouter

#endif  // DEBUGROUTER_NATIVE_ANDROID_DEBUG_ROUTER_SESSION_HANDLER_ANDROID_H_
