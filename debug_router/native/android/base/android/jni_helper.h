// Copyright 2024 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

#ifndef DEBUGROUTER_NATIVE_ANDROID_BASE_ANDROID_JNI_HELPER_H_
#define DEBUGROUTER_NATIVE_ANDROID_BASE_ANDROID_JNI_HELPER_H_

#include <jni.h>

#include <string>

#include "debug_router/native/android/base/android/java_type.h"
#include "debug_router/native/android/base/android/scoped_java_ref.h"

namespace debugrouter {
namespace common {
namespace android {
class JNIHelper {
 public:
  static debugrouter::common::android::ScopedLocalJavaRef<jstring>
  ConvertToJNIStringRef(JNIEnv *env, const std::string &value);

  static jstring ConvertToJNIString(JNIEnv *env, const std::string &str);

  static std::string ConvertToString(JNIEnv *env, jstring value);

  static jbyteArray ConvertToByteArray(JNIEnv *env, const std::string &str);

  static std::vector<uint8_t> ConvertJavaBinary(JNIEnv *env,
                                                jbyteArray jbinary);

  inline static int ConvertToInt(JNIEnv *env, jobject jobj) {
    int value = JType::IntValue(env, jobj);
    return value;
  }

  inline static long ConvertToLong(JNIEnv *env, jobject jobj) {
    long value = (long)JType::LongValue(env, jobj);
    return value;
  }

  inline static float ConvertToFloat(JNIEnv *env, jobject jobj) {
    float value = (float)JType::FloatValue(env, jobj);
    return value;
  }

  inline static double ConvertToDouble(JNIEnv *env, jobject jobj) {
    double value = (double)JType::DoubleValue(env, jobj);
    return value;
  }

  inline static bool ConvertToBoolean(JNIEnv *env, jobject jobj) {
    jboolean value = JType::BooleanValue(env, jobj);
    return (bool)(value == JNI_TRUE);
  }

  static std::vector<std::string> ConvertJavaStringArrayToStringVector(
      JNIEnv *env, jobjectArray array);
};
}  // namespace android
}  // namespace common
}  // namespace debugrouter

#endif  // DEBUGROUTER_NATIVE_ANDROID_BASE_ANDROID_JNI_HELPER_H_
