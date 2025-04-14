// Copyright 2024 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

#include <jni.h>

#include "debug_router/native/android/MessageAssembler_impl.h"
#include "debug_router/native/android/base/android/android_jni.h"
#include "debug_router/native/android/debug_router_android.h"
#include "debug_router/native/android/debug_router_global_handler_android.h"
#include "debug_router/native/android/debug_router_listener_android.h"
#include "debug_router/native/android/debug_router_report_service_android.h"
#include "debug_router/native/android/debug_router_session_handler_android.h"
#include "debug_router/native/android/log/LLog_impl.h"
#include "debug_router/native/android/message_handler_android.h"
#include "debug_router/native/android/native_slot_android.h"

namespace debugrouter {

extern "C" JNIEXPORT jint JNI_OnLoad(JavaVM *vm, void *reserved) {
  debugrouter::common::android::InitVM(vm);
  JNIEnv *env = debugrouter::common::android::AttachCurrentThread();
  debugrouter::android::DebugRouterAndroid::RegisterJNIUtils(env);
  debugrouter::android::NativeSlotAndroid::RegisterJNIUtils(env);
  debugrouter::android::DebugRouterListenerAndroid::RegisterJNIUtils(env);
  debugrouter::android::DebugRouterReportServiceAndroid::RegisterJNIUtils(env);
  debugrouter::android::MessageHandlerAndroid::RegisterJNIUtils(env);
  debugrouter::android::DebugRouterGlobalHandlerAndroid::RegisterJNIUtils(env);
  debugrouter::android::DebugRouterSessionHandlerAndroid::RegisterJNIUtils(env);
  debugrouter::android::MessageAssemberJNI::RegisterJNIUtils(env);
  debugrouter::logging::LoggingDelegateAndroid::RegisterJNI(env);

  return JNI_VERSION_1_6;
}

}  // namespace debugrouter
