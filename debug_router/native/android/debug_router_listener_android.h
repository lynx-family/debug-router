// Copyright 2024 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

#ifndef DEBUGROUTER_NATIVE_ANDROID_DEBUG_ROUTER_LISTENER_ANDROID_H_
#define DEBUGROUTER_NATIVE_ANDROID_DEBUG_ROUTER_LISTENER_ANDROID_H_

#include <jni.h>

#include "debug_router/native/android/base/android/scoped_java_ref.h"
#include "debug_router/native/core/debug_router_state_listener.h"

namespace debugrouter {
namespace android {

class DebugRouterListenerAndroid : public core::DebugRouterStateListener {
 public:
  DebugRouterListenerAndroid(JNIEnv *env, jobject listener);
  virtual ~DebugRouterListenerAndroid() = default;
  void OnOpen(core::ConnectionType type) override;
  void OnClose(int32_t code, const std::string &reason) override;
  void OnMessage(const std::string &message) override;
  void OnError(const std::string &error) override;
  static bool RegisterJNIUtils(JNIEnv *env);

 private:
  std::unique_ptr<debugrouter::common::android::ScopedGlobalJavaRef<jobject>>
      listener_ptr_;
};

}  // namespace android
}  // namespace debugrouter

#endif  // DEBUGROUTER_NATIVE_ANDROID_DEBUG_ROUTER_LISTENER_ANDROID_H_
