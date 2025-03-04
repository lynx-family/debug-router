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
 *
 */

// Copyright 2024 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

#include "debug_router/native/android/base/android/scoped_java_ref.h"

#include <vector>

#include "debug_router/native/android/base/android/android_jni.h"

namespace debugrouter {
namespace common {
namespace android {

JavaRef::JavaRef() : obj_(nullptr) {}

JavaRef::JavaRef(JNIEnv *env, jobject obj) : obj_(obj) {}

void JavaRef::ResetNewLocalRef(JNIEnv *env, jobject obj) {
  if (!env) {
    env = AttachCurrentThread();
  }
  if (obj) {
    obj = env->NewLocalRef(obj);
  }

  if (obj_) env->DeleteLocalRef(obj_);
  obj_ = obj;
}

void JavaRef::ReleaseLocalRef(JNIEnv *env) {
  if (!obj_) {
    return;
  }
  if (!env) {
    env = AttachCurrentThread();
  }
  env->DeleteLocalRef(obj_);
  obj_ = nullptr;
}

void JavaRef::ResetNewGlobalRef(JNIEnv *env, jobject obj) {
  if (!env) {
    env = AttachCurrentThread();
  }

  if (obj) obj = env->NewGlobalRef(obj);
  if (obj_) env->DeleteGlobalRef(obj_);
  obj_ = obj;
}

void JavaRef::ReleaseGlobalRef(JNIEnv *env) {
  if (obj_ == NULL) {
    return;
  }
  if (!env) {
    env = AttachCurrentThread();
  }

  if (!env) {
    // Oppo Android 5.1, JNIEnv is null when destruct global JavaRef in thread
    // exit call stack; so we need to return here.
    return;
  }

  env->DeleteGlobalRef(obj_);
  obj_ = nullptr;
}

void JavaRef::ResetNewWeakGlobalRef(JNIEnv *env, jobject obj) {
  if (!env) {
    env = AttachCurrentThread();
  }
  if (obj) obj = env->NewWeakGlobalRef(obj);
  if (obj_) env->DeleteWeakGlobalRef(obj_);
  obj_ = obj;
}

void JavaRef::ReleaseWeakGlobalRef(JNIEnv *env) {
  if (obj_ == NULL) {
    return;
  }
  if (!env) {
    env = AttachCurrentThread();
  }
  env->DeleteWeakGlobalRef(obj_);
  obj_ = nullptr;
}

}  // namespace android
}  // namespace common
}  // namespace debugrouter
