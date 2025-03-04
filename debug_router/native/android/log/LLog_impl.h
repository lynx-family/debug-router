// Copyright 2024 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

#ifndef DEBUGROUTER_NATIVE_ANDROID_LOG_LLOG_IMPL_H_
#define DEBUGROUTER_NATIVE_ANDROID_LOG_LLOG_IMPL_H_

#include "debug_router/native/android/base/android/android_jni.h"
#include "debug_router/native/log/logging.h"

namespace debugrouter {
namespace logging {
class LogMessage;

class LoggingDelegateAndroid : public LoggingDelegate {
 public:
  static bool RegisterJNI(JNIEnv *env);
  void Log(LogMessage *msg) override;
};

}  // namespace logging
}  // namespace debugrouter

#endif  // DEBUGROUTER_NATIVE_ANDROID_LOG_LLOG_IMPL_H_
