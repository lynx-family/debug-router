// Copyright 2024 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

#include "debug_router/native/android/MessageAssembler_impl.h"

#include "debug_router/android/build/gen/MessageAssembler_jni.h"
#include "debug_router/native/android/base/android/jni_helper.h"
#include "debug_router/native/processor/message_assembler.h"
#include "json/json.h"

jstring AssembleDispatchDocumentUpdated(JNIEnv *env, jclass jcaller) {
  auto msg = debugrouter::processor::MessageAssembler::
      AssembleDispatchDocumentUpdated();
  return debugrouter::common::android::JNIHelper::ConvertToJNIString(env, msg);
}

jstring AssembleDispatchFrameNavigated(JNIEnv *env, jclass jcaller,
                                       jstring url) {
  auto msg =
      debugrouter::processor::MessageAssembler::AssembleDispatchFrameNavigated(
          debugrouter::common::android::JNIHelper::ConvertToString(env, url));
  return debugrouter::common::android::JNIHelper::ConvertToJNIString(env, msg);
}

jstring AssembleDispatchScreencastVisibilityChanged(JNIEnv *env, jclass jcaller,
                                                    jboolean status) {
  auto msg = debugrouter::processor::MessageAssembler::
      AssembleDispatchScreencastVisibilityChanged(status == JNI_TRUE);
  return debugrouter::common::android::JNIHelper::ConvertToJNIString(env, msg);
}

jstring AssembleScreenCastFrame(JNIEnv *env, jclass jcaller, jint sessionId,
                                jstring data, jstring metaData) {
  std::unordered_map<std::string, float> md;
  auto jsonStr =
      debugrouter::common::android::JNIHelper::ConvertToString(env, metaData);
  Json::Reader reader;
  Json::Value jsonValue;
  reader.parse(jsonStr, jsonValue);
  if (jsonValue.type() == Json::ValueType::objectValue) {
    for (auto iter = jsonValue.begin(); iter != jsonValue.end(); iter++) {
      auto key = iter.key().asString();
      md[key] = jsonValue[key].asFloat();
    }
  }

  auto msg = debugrouter::processor::MessageAssembler::AssembleScreenCastFrame(
      sessionId,
      debugrouter::common::android::JNIHelper::ConvertToString(env, data), md);
  return debugrouter::common::android::JNIHelper::ConvertToJNIString(env, msg);
}

namespace debugrouter {
namespace android {

bool MessageAssemberJNI::RegisterJNIUtils(JNIEnv *env) {
  return RegisterNativesImpl(env);
}

}  // namespace android
}  // namespace debugrouter
