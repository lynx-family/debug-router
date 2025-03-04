// Copyright 2024 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

#include "debug_router/native/android/base/android/jni_helper.h"

#include <vector>

namespace debugrouter {
namespace common {
namespace android {

debugrouter::common::android::ScopedLocalJavaRef<jstring>
JNIHelper::ConvertToJNIStringRef(JNIEnv *env, const std::string &value) {
  jstring str = env->NewStringUTF(value.c_str());
  return debugrouter::common::android::ScopedLocalJavaRef<jstring>(env, str);
}

jstring JNIHelper::ConvertToJNIString(JNIEnv *env, const std::string &str) {
  return env->NewStringUTF(str.c_str());
}

jbyteArray JNIHelper::ConvertToByteArray(JNIEnv *env, const std::string &str) {
  jbyteArray array = env->NewByteArray(str.length());
  env->SetByteArrayRegion(array, 0, str.length(),
                          reinterpret_cast<const jbyte *>(str.c_str()));
  return array;
}

std::vector<uint8_t> JNIHelper::ConvertJavaBinary(JNIEnv *env,
                                                  jbyteArray jbinary) {
  std::vector<uint8_t> binary;
  if (jbinary != nullptr) {
    auto *temp = env->GetByteArrayElements(jbinary, JNI_FALSE);
    size_t len = env->GetArrayLength(jbinary);
    if (len > 0) {
      binary.resize(len);
      std::memcpy(binary.data(), temp, len);
    }
    env->ReleaseByteArrayElements(jbinary, temp, JNI_FALSE);
  }
  return binary;
}

std::string JNIHelper::ConvertToString(JNIEnv *env, jstring jstr) {
  std::string res;
  if (jstr != nullptr) {
    const char *str = env->GetStringUTFChars(jstr, JNI_FALSE);
    if (str) {
      res = std::string(str);
    }
    env->ReleaseStringUTFChars(jstr, str);
  }
  return res;
}

std::vector<std::string> JNIHelper::ConvertJavaStringArrayToStringVector(
    JNIEnv *env, jobjectArray array) {
  std::vector<std::string> result;
  if (array == nullptr) {
    return result;
  }
  jsize len = env->GetArrayLength(array);
  for (size_t i = 0; i < len; ++i) {
    auto java_obj =
        ScopedLocalJavaRef<jobject>(env, env->GetObjectArrayElement(array, i));
    result.emplace_back(
        ConvertToString(env, static_cast<jstring>(java_obj.Get())));
  }
  return result;
}

}  // namespace android
}  // namespace common
}  // namespace debugrouter
