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

// Copyright 2019 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

#include "debug_router/native/android/base/android/android_jni.h"

#include <android/log.h>

namespace {
JavaVM *g_jvm = nullptr;
}

namespace debugrouter {
namespace common {
namespace android {

void InitVM(JavaVM *vm) { g_jvm = vm; }

JNIEnv *AttachCurrentThread() {
  JNIEnv *env = nullptr;
  g_jvm->AttachCurrentThread(&env, nullptr);
  return env;
}

void DetachFromVM() {
  if (g_jvm) {
    g_jvm->DetachCurrentThread();
  }
}

ScopedLocalJavaRef<jclass> GetClass(JNIEnv *env, const char *class_name) {
  jclass clazz = env->FindClass(class_name);
  if (ClearException(env) || !clazz) {
    std::string msg = "Failed to find class " + std::string(class_name);
    __android_log_write(ANDROID_LOG_FATAL, "lynx", msg.c_str());
  }
  return ScopedLocalJavaRef<jclass>(env, clazz);
}

ScopedGlobalJavaRef<jclass> GetGlobalClass(JNIEnv *env,
                                           const char *class_name) {
  jclass clazz = env->FindClass(class_name);
  if (ClearException(env) || !clazz) {
    std::string msg = "Failed to find class " + std::string(class_name ?: "");
    __android_log_write(ANDROID_LOG_FATAL, "lynx", msg.c_str());
  }
  return ScopedGlobalJavaRef<jclass>(env, clazz);
}

jmethodID GetMethod(JNIEnv *env, jclass clazz, MethodType type,
                    const char *method_name, const char *jni_signature) {
  jmethodID id = 0;
  if (clazz) {
    if (type == STATIC_METHOD) {
      id = env->GetStaticMethodID(clazz, method_name, jni_signature);
    } else if (type == INSTANCE_METHOD) {
      id = env->GetMethodID(clazz, method_name, jni_signature);
    }
    if (ClearException(env) || !id) {
      std::string msg = "Failed to find " +
                        std::string((type == STATIC_METHOD) ? "static" : "") +
                        std::string(method_name ?: "") +
                        std::string(jni_signature ?: "");
      __android_log_write(ANDROID_LOG_FATAL, "lynx", msg.c_str());
    }
  }
  return id;
}

jmethodID GetMethod(JNIEnv *env, jclass clazz, MethodType type,
                    const char *method_name, const char *jni_signature,
                    intptr_t *method_id) {
  if (*method_id) {
    return reinterpret_cast<jmethodID>(*method_id);
  }
  *method_id = reinterpret_cast<intptr_t>(
      GetMethod(env, clazz, type, method_name, jni_signature));
  return reinterpret_cast<jmethodID>(*method_id);
}

bool HasException(JNIEnv *env) { return env->ExceptionCheck() != JNI_FALSE; }

bool ClearException(JNIEnv *env) {
  if (!HasException(env)) return false;
  env->ExceptionDescribe();
  env->ExceptionClear();
  return true;
}

bool &HasJNIException() {
  static thread_local bool has_jni_exception = false;
  return has_jni_exception;
}

void CheckException(JNIEnv *env) {
  HasJNIException() = false;
  if (!HasException(env)) return;

  // Exception has been found, might as well tell BreakPad about it.
  debugrouter::common::android::ScopedLocalJavaRef<jthrowable> throwable(
      env, env->ExceptionOccurred());
  if (throwable.Get()) {
    // Clear the pending exception, since a local reference is now held.
    env->ExceptionDescribe();
    env->ExceptionClear();
    HasJNIException() = true;
  }
}

}  // namespace android
}  // namespace common
}  // namespace debugrouter
