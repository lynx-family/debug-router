// Copyright 2024 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

#ifndef DEBUGROUTER_NATIVE_ANDROID_NATIVE_SLOT_ANDROID_H_
#define DEBUGROUTER_NATIVE_ANDROID_NATIVE_SLOT_ANDROID_H_

#include <jni.h>

#include <memory>

#include "debug_router/native/android/base/android/scoped_java_ref.h"
#include "debug_router/native/core/native_slot.h"

namespace debugrouter {
namespace android {

class NativeSlotAndroid : public core::NativeSlot {
 public:
  static bool RegisterJNIUtils(JNIEnv *env);
  explicit NativeSlotAndroid(JNIEnv *env, jobject slot);
  virtual ~NativeSlotAndroid() = default;
  virtual void OnMessage(const std::string &message,
                         const std::string &type) override;

 private:
  std::unique_ptr<debugrouter::common::android::ScopedGlobalJavaRef<jobject>>
      jobj_ptr_;
};

}  // namespace android
}  // namespace debugrouter

#endif  // DEBUGROUTER_NATIVE_ANDROID_NATIVE_SLOT_ANDROID_H_
