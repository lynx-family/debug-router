/**
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

// Copyright 2024 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

#ifndef DEBUGROUTER_NATIVE_ANDROID_BASE_ANDROID_ANDROID_JNI_H_
#define DEBUGROUTER_NATIVE_ANDROID_BASE_ANDROID_ANDROID_JNI_H_

#include <jni.h>

#include <cstdint>

#include "debug_router/native/android/base/android/scoped_java_ref.h"

namespace debugrouter {
namespace common {
namespace android {

void InitVM(JavaVM *vm);

JNIEnv *AttachCurrentThread();

void DetachFromVM();

ScopedLocalJavaRef<jclass> GetClass(JNIEnv *env, const char *class_name);

ScopedGlobalJavaRef<jclass> GetGlobalClass(JNIEnv *env, const char *class_name);

enum MethodType {
  STATIC_METHOD,
  INSTANCE_METHOD,
};

jmethodID GetMethod(JNIEnv *env, jclass clazz, MethodType type,
                    const char *method_name, const char *jni_signature);

jmethodID GetMethod(JNIEnv *env, jclass clazz, MethodType type,
                    const char *method_name, const char *jni_signature,
                    intptr_t *method_id);

bool HasException(JNIEnv *env);
bool ClearException(JNIEnv *env);
void CheckException(JNIEnv *env);

// Used to indicate whether there is an jni exception after a jni call.
// It should be noted that only the result checked by calling this method
// immediately after JNI invocation is valid.
bool &HasJNIException();

class JniLocalScope {
 public:
  JniLocalScope(JNIEnv *env, jint capacity = 256) : env_(env) {
    hasFrame_ = false;

    for (size_t i = capacity; i > 0; i /= 2) {
      auto pushResult = env->PushLocalFrame(i);
      if (pushResult == 0) {
        hasFrame_ = true;
        break;
      }

      // if failed, clear the exception and try again with less capacity
      if (pushResult < 0) {
        jthrowable java_throwable = env->ExceptionOccurred();
        if (java_throwable) {
          env->ExceptionClear();
          env->DeleteLocalRef(java_throwable);
        }
      }
    }
  }

  ~JniLocalScope() {
    if (hasFrame_) {
      env_->PopLocalFrame(nullptr);
    }
  }

 private:
  JNIEnv *env_;
  bool hasFrame_;
};

}  // namespace android
}  // namespace common
}  // namespace debugrouter

#endif  // DEBUGROUTER_NATIVE_ANDROID_BASE_ANDROID_ANDROID_JNI_H_
