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

#ifndef DEBUGROUTER_NATIVE_ANDROID_BASE_ANDROID_SCOPED_JAVA_REF_H_
#define DEBUGROUTER_NATIVE_ANDROID_BASE_ANDROID_SCOPED_JAVA_REF_H_

#include <jni.h>

#include <string>

namespace debugrouter {
namespace common {
namespace android {

class JavaRef {
 public:
  JavaRef();

  JavaRef(JNIEnv *env, jobject obj);

  ~JavaRef() {}

  void ResetNewLocalRef(JNIEnv *env, jobject obj);

  void ReleaseLocalRef(JNIEnv *env);

  void ResetNewGlobalRef(JNIEnv *env, jobject obj);

  void ReleaseGlobalRef(JNIEnv *env);

  void ResetNewWeakGlobalRef(JNIEnv *env, jobject obj);

  void ReleaseWeakGlobalRef(JNIEnv *env);

  jobject Get() const { return obj_; }

  bool IsNull() const { return obj_ == nullptr; }

  virtual bool IsLocal() const { return false; }
  virtual bool IsGlobal() const { return false; }
  virtual bool IsWeakGlobal() const { return false; }

 protected:
  jobject obj_ = nullptr;
};

/* Note: Be careful to put ScopedLocalJavaRef in vector or other containers
 * which may use ScopedLocalJavaRef's copy constructor or copy assignment
 * operator, only if you wrap it with shared_ptr or declare move semantics
 * function with noexcept. ScopedLocalJavaRef's copy semantics function actually
 * do move behavior here.
 * */
// TODO: Delete ScopedLocalJavaRef's copy constructor or copy assignment
// operator.
// TODO: Add noexcept in move semantics function.
template <typename T>
class ScopedLocalJavaRef final : public JavaRef {
 public:
  ScopedLocalJavaRef() : env_(nullptr) {}

  ScopedLocalJavaRef(JNIEnv *env, T obj) : JavaRef(env, obj), env_(env) {}

  ScopedLocalJavaRef(const ScopedLocalJavaRef<T> &other) : env_(other.env_) {
    Reset(env_, other.Get());
  }

  ScopedLocalJavaRef(const JavaRef &other) { Reset(env_, other.Get()); }

  ScopedLocalJavaRef(ScopedLocalJavaRef<T> &&other) {
    obj_ = other.obj_;
    other.obj_ = nullptr;
  }

  bool IsLocal() const override { return true; }

  void operator=(const ScopedLocalJavaRef<T> &other) {
    env_ = other.env_;
    Reset(env_, other.Get());
  }

  ~ScopedLocalJavaRef() { ReleaseLocalRef(env_); }

  void Reset(JNIEnv *env, jobject obj) { ResetNewLocalRef(env, obj); }
  void Reset() { ReleaseLocalRef(env_); }

  T Get() const { return (T)obj_; }

 private:
  JNIEnv *env_ = nullptr;
};

/* Note: Be careful to put ScopedGlobalJavaRef in vector or other containers
 * which may use ScopedGlobalJavaRef's copy constructor or copy assignment
 * operator, only if you wrap it with shared_ptr or declare move semantics
 * function with noexcept. ScopedGlobalJavaRef's copy semantics function
 * actually do move behavior here.
 * */
// TODO: Delete ScopedGlobalJavaRef's copy constructor or copy assignment
// operator.
// TODO: Add noexcept in move semantics function.
template <typename T>
class ScopedGlobalJavaRef final : public JavaRef {
 public:
  ScopedGlobalJavaRef() {}

  ScopedGlobalJavaRef(JNIEnv *env, T obj) { Reset(env, obj); }

  ScopedGlobalJavaRef(const ScopedGlobalJavaRef<T> &other) {
    Reset(nullptr, other.Get());
  }

  ScopedGlobalJavaRef(const ScopedLocalJavaRef<T> &other) {
    Reset(nullptr, other.Get());
  }

  ScopedGlobalJavaRef(ScopedGlobalJavaRef<T> &&other) {
    obj_ = other.obj_;
    other.obj_ = nullptr;
  }

  ~ScopedGlobalJavaRef() { ReleaseGlobalRef(nullptr); }

  bool IsGlobal() const override { return true; }

  void operator=(const ScopedGlobalJavaRef<T> &other) {
    Reset(nullptr, other.Get());
  }

  void Reset(JNIEnv *env, const ScopedLocalJavaRef<T> &other) {
    ResetNewGlobalRef(env, other.Get());  // NOLINT
  }

  void Reset(JNIEnv *env, jobject obj) { ResetNewGlobalRef(env, obj); }

  T Get() const { return (T)obj_; }
};

/* Note: Be careful to put ScopedWeakGlobalJavaRef in vector or other containers
 * which may use ScopedWeakGlobalJavaRef's copy constructor or copy assignment
 * operator, only if you wrap it with shared_ptr or declare move semantics
 * function with noexcept. ScopedWeakGlobalJavaRef's copy semantics function
 * actually do move behavior here.
 * */
// TODO: Delete ScopedWeakGlobalJavaRef's copy constructor or copy assignment
// operator.
// TODO: Add noexcept in move semantics function.
template <typename T>
class ScopedWeakGlobalJavaRef : public JavaRef {
 public:
  ScopedWeakGlobalJavaRef() {}

  ScopedWeakGlobalJavaRef(JNIEnv *env, T obj) { Reset(env, obj); }

  ScopedWeakGlobalJavaRef(const ScopedGlobalJavaRef<T> &other) {
    Reset(nullptr, other.Get());
  }

  ScopedWeakGlobalJavaRef(const ScopedLocalJavaRef<T> &other) {
    Reset(nullptr, other.Get());
  }

  ~ScopedWeakGlobalJavaRef() { ReleaseWeakGlobalRef(nullptr); }

  bool IsWeakGlobal() const override { return true; }

  void operator=(const ScopedWeakGlobalJavaRef<T> &other) {
    Reset(nullptr, other.Get());
  }

  void Reset(JNIEnv *env, const ScopedLocalJavaRef<T> &other) {
    ResetNewWeakGlobalRef(env, other.Get());
  }

  void Reset(JNIEnv *env, jobject obj) {
    ResetNewWeakGlobalRef(env, obj);  // NOLINT
  }

  T Get() const { return (T)obj_; }
};

}  // namespace android
}  // namespace common
}  // namespace debugrouter

#endif  // DEBUGROUTER_NATIVE_ANDROID_BASE_ANDROID_SCOPED_JAVA_REF_H_
