// Copyright 2025 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

#include "debug_router/native/harmony/debug_router_log_harmony.h"

#include <hilog/log.h>
#define HARMONY_LOG_PRINT_DOMAIN 0xAA00

namespace debugrouter {
namespace logging {
class LogMessage;

class HarmonyLoggingDelegate : public LoggingDelegate {
 public:
  HarmonyLoggingDelegate() = default;
  ~HarmonyLoggingDelegate() override = default;

  void Log(LogMessage* msg) override { harmony::Log(msg); }
};
}  // namespace logging

#define LogMessage logging::LogMessage

namespace harmony {
void InitializeHarmonyLogging() {
  logging::SetLoggingDelegate(
      std::make_unique<logging::HarmonyLoggingDelegate>());
}

void Log(LogMessage* msg) {
  LogLevel priority = LogLevel::LOG_DEBUG;
  switch (msg->severity()) {
    case logging::LOG_VERBOSE:
      priority = LogLevel::LOG_DEBUG;
      break;
    case logging::LOG_INFO:
      priority = LogLevel::LOG_INFO;
      break;
    case logging::LOG_WARNING:
      priority = LogLevel::LOG_WARN;
      break;
    case logging::LOG_ERROR:
      priority = LogLevel::LOG_ERROR;
      break;
    case logging::LOG_FATAL:
      priority = LogLevel::LOG_FATAL;
      break;
  }
  const char* tag = "DebugRouter";
  OH_LOG_Print(LOG_APP, priority, HARMONY_LOG_PRINT_DOMAIN, tag, "%{public}s",
               msg->stream().str().c_str());
}

}  // namespace harmony
}  // namespace debugrouter
