// Copyright 2024 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

#ifndef DEBUGROUNTER_NATIVE_ANDROID_BASE_LOGGING_H
#define DEBUGROUNTER_NATIVE_ANDROID_BASE_LOGGING_H

#include <android/log.h>

#define LOG_TAG "debugrouter"
#define LOGV(message) __android_log_write(ANDROID_LOG_VERBOSE, LOG_TAG, message)
#define LOGD(message) __android_log_write(ANDROID_LOG_DEBUG, LOG_TAG, message)
#define LOGI(message) __android_log_write(ANDROID_LOG_INFO, LOG_TAG, message)
#define LOGW(message) __android_log_write(ANDROID_LOG_WARN, LOG_TAG, message)
#define LOGE(message) __android_log_write(ANDROID_LOG_ERROR, LOG_TAG, message)

#endif  // DEBUGROUNTER_NATIVE_ANDROID_BASE_LOGGING_H
