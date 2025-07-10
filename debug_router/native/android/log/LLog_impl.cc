// Copyright 2024 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

#include "debug_router/native/android/log/LLog_impl.h"

#include <android/log.h>

#include "debug_router/android/build/gen/LLog_jni.h"

void SetNativeMinLogLevel(JNIEnv *env, jclass jcaller, jint level) {
  debugrouter::logging::SetMinLogLevel(level);
}

void SetHasLoggingDelegate(JNIEnv *env, jclass jcaller, jboolean has) {
  debugrouter::logging::SetLoggingDelegate(
      has ? std::make_unique<debugrouter::logging::LoggingDelegateAndroid>()
          : nullptr);
}

namespace debugrouter {
namespace logging {
namespace {
typedef enum android_LogPriority {
  /** For internal use only.  */
  ANDROID_LOG_UNKNOWN = 0,
  /** The default priority, for internal use only.  */
  ANDROID_LOG_DEFAULT, /* only for SetMinPriority() */
  /** Verbose logging. Should typically be disabled for a release apk. */
  ANDROID_LOG_VERBOSE,
  /** Debug logging. Should typically be disabled for a release apk. */
  ANDROID_LOG_DEBUG,
  /** Informational logging. Should typically be disabled for a release apk. */
  ANDROID_LOG_INFO,
  /** Warning logging. For use with recoverable failures. */
  ANDROID_LOG_WARN,
  /** Error logging. For use with unrecoverable failures. */
  ANDROID_LOG_ERROR,
  /** Fatal logging. For use when aborting. */
  ANDROID_LOG_FATAL,
  /** For internal use only.  */
  ANDROID_LOG_SILENT, /* only for SetMinPriority(); must be last */
} android_LogPriority;
}

bool LoggingDelegateAndroid::RegisterJNI(JNIEnv *env) {
  return RegisterNativesImpl(env);
}

void LoggingDelegateAndroid::Log(debugrouter::logging::LogMessage *msg) {
  JNIEnv *env = common::android::AttachCurrentThread();
  if (msg->severity() < debugrouter::logging::GetMinLogLevel()) {
    return;
  }

  int priority =
      (msg->severity() < 0) ? ANDROID_LOG_VERBOSE : ANDROID_LOG_UNKNOWN;
  switch (msg->severity()) {
    case LOG_INFO:
      priority = ANDROID_LOG_INFO;
      break;
    case LOG_WARNING:
      priority = ANDROID_LOG_WARN;
      break;
    case LOG_ERROR:
      priority = ANDROID_LOG_ERROR;
      break;
    case LOG_FATAL:
      priority = ANDROID_LOG_FATAL;
      break;
  }

  auto c_msg = msg->stream().str();
  static debugrouter::common::android::ScopedGlobalJavaRef<jstring> lynx_tag(
      env, env->NewStringUTF("DebugRouter"));
  auto jni_msg = env->NewStringUTF(c_msg.c_str());
  Java_LLog_log(env, priority, (jstring)lynx_tag.Get(), jni_msg);
  env->DeleteLocalRef(jni_msg);
}
}  // namespace logging
}  // namespace debugrouter
