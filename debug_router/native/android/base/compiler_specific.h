// Copyright 2024 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

#ifndef DEBUGROUTER_NATIVE_ANDROID_BASE_COMPILER_SPECIFIC_H_
#define DEBUGROUTER_NATIVE_ANDROID_BASE_COMPILER_SPECIFIC_H_

#if !defined(UNLIKELY)
#if defined(COMPILER_GCC) || defined(__clang__)
#define UNLIKELY(x) __builtin_expect(!!(x), 0)
#else
#define UNLIKELY(x) (x)
#endif
#endif

#if !defined(LIKELY)
#if defined(COMPILER_GCC) || defined(__clang__)
#define LIKELY(x) __builtin_expect(!!(x), 1)
#else
#define LIKELY(x) (x)
#endif
#endif

#undef WARN_UNUSED_RESULT
#if defined(COMPILER_GCC) || defined(__clang__)
#define WARN_UNUSED_RESULT __attribute__((warn_unused_result))
#else
#define WARN_UNUSED_RESULT
#endif

// Compiler feature-detection.
// clang.llvm.org/docs/LanguageExtensions.html#has-feature-and-has-extension
#if defined(__has_feature)
#define HAS_FEATURE(FEATURE) __has_feature(FEATURE)
#else
#define HAS_FEATURE(FEATURE) 0
#endif

#define ALLOW_UNUSED_LOCAL(x) (void)x

#if defined(__GUNC__) || defined(__clang__)
#define ALLOW_UNUSED_TYPE __attribute__((unused))
#else
#define AALLOW_UNUSED_TYPE
#endif

#endif  // DEBUGROUTER_NATIVE_ANDROID_BASE_COMPILER_SPECIFIC_H_
