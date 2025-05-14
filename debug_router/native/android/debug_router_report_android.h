// Copyright 2025 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

#ifndef DEBUGROUTER_NATIVE_ANDROID_DEBUG_ROUTER_REPORT_ANDROID_H_
#define DEBUGROUTER_NATIVE_ANDROID_DEBUG_ROUTER_REPORT_ANDROID_H_

#include <jni.h>

#include <memory>

#include "debug_router/native/android/base/android/scoped_java_ref.h"
#include "debug_router/native/report/debug_router_native_report.h"

namespace debugrouter {
namespace android {

class DebugRouterReportAndroid : public report::DebugRouterNativeReport {
 public:
  static bool RegisterJNIUtils(JNIEnv *env);
  DebugRouterReportAndroid(JNIEnv *env, jobject slot);
  virtual ~DebugRouterReportAndroid() override = default;

  void report(const std::string &eventName, const std::string &category,
              const std::string &metric, const std::string &extra) override;

 private:
  std::unique_ptr<debugrouter::common::android::ScopedGlobalJavaRef<jobject>>
      jobj_ptr_;
};

}  // namespace android
}  // namespace debugrouter

#endif  // DEBUGROUTER_NATIVE_ANDROID_DEBUG_ROUTER_REPORT_ANDROID_H_
