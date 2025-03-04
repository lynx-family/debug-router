// Copyright 2023 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

#include "debug_router/native/log/logging.h"

#include <algorithm>
#include <cstring>
#include <ctime>
#include <iomanip>
#include <ostream>
#include <string>

#if defined(OS_ANDROID)
#include <android/log.h>
#endif

#if !defined(_WIN32)
#include <unistd.h>
#endif

namespace debugrouter {
namespace logging {
namespace {

const char *const log_severity_names[LOG_NUM_SEVERITIES] = {
    "VERBOSE", "INFO", "WARNING", "ERROR", "REPORT", "FATAL"};

const char *log_severity_name(int severity) {
  if (severity >= LOG_VERBOSE && severity <= LOG_FATAL) {
    return log_severity_names[severity + 1];
  }
  return "UNKNOWN";
}
// the log level to output
bool hasSetDelegate = false;

int g_min_log_level = DEBUGROUTER_LOG_LEVEL_VERBOSE;

LoggingDestination g_logging_destination = LOG_DEFAULT;

std::unique_ptr<LoggingDelegate> g_logging_delegate = nullptr;
}  // namespace

void SetLoggingDelegate(std::unique_ptr<LoggingDelegate> delegate) {
  if (hasSetDelegate) {
    return;
  }
  hasSetDelegate = true;
  g_logging_delegate = std::move(delegate);
}

void SetMinLogLevel(int level) { g_min_log_level = std::min(LOG_FATAL, level); }

int GetMinLogLevel() { return g_min_log_level; }

int GetMinAllLogLevel() { return std::min(g_min_log_level, LOG_INFO); }

LogMessage::LogMessage(const char *file, int line, LogSeverity severity,
                       LogSource source, int64_t rt_id)
    : severity_(severity),
      file_(file),
      line_(line),
      source_(source),
      runtime_id_(rt_id) {
  // FIXME(shouqun): Suppress unused warning.
  (void)line_;
  (void)file_;
  Init(file, line);
}

LogMessage::LogMessage(const char *file, int line, LogSeverity severity)
    : severity_(severity),
      file_(file),
      line_(line),
      source_(LOG_SOURCE_NATIVE),
      runtime_id_(-1) {
  Init(file, line);
}

LogMessage::LogMessage(const char *file, int line, std::string *result)
    : severity_(LOG_FATAL), file_(file), line_(line) {
  Init(file, line);
  stream_ << "Check failed: " << *result;
  delete result;
}

LogMessage::LogMessage(const char *file, int line, LogSeverity severity,
                       std::string *result)
    : severity_(severity), file_(file), line_(line) {
  Init(file, line);
  stream_ << "Check failed: " << *result;
  delete result;
}

LogMessage::~LogMessage() {
  stream_ << std::endl;

  if ((g_logging_destination & LOG_TO_SYSTEM_DEBUG_LOG) != 0) {
    if (g_logging_delegate) {
      g_logging_delegate->Log(this);
    } else {  // default implementation
      std::string str_newline(stream_.str());
#if defined(OS_ANDROID)
      android_LogPriority priority =
          (severity_ < 0) ? ANDROID_LOG_VERBOSE : ANDROID_LOG_UNKNOWN;
      switch (severity_) {
        case LOG_INFO:
          priority = ANDROID_LOG_INFO;
          break;
        case LOG_WARNING:
          priority = ANDROID_LOG_WARN;
          break;
        case LOG_ERROR:
          priority = ANDROID_LOG_ERROR;
          break;
        case LOG_FATAL:
          priority = ANDROID_LOG_FATAL;
          break;
        case LOG_REPORT:
          // default use error level
          priority = ANDROID_LOG_ERROR;
          break;
      }
      // android will abort here
      __android_log_write(priority, "debugrouter", str_newline.c_str());
#elif !defined(NDEBUG)
      printf("debugrouter: %s\n", str_newline.c_str());
#endif
    }
  }

  if (severity_ == LOG_FATAL) {
    abort();
  }
}

// writes the common header info to the stream
void LogMessage::Init(const char *file, int line) {
  std::string filename(file);
  size_t last_slash_pos = filename.find_last_of("\\/");
  if (last_slash_pos != std::string::npos) {
    size_t size = last_slash_pos + 1;
    filename = filename.substr(size, filename.length() - size);
  }

  stream_ << '[';

  time_t t = time(NULL);
  struct tm local_time = {0};

#if defined(_WIN32)
  localtime_s(&local_time, &t);
#else
  localtime_r(&t, &local_time);
#endif

  struct tm *tm_time = &local_time;
  stream_ << std::setfill('0') << std::setw(2) << 1 + tm_time->tm_mon
          << std::setw(2) << tm_time->tm_mday << '/' << std::setw(2)
          << tm_time->tm_hour << ":" << std::setw(2) << tm_time->tm_min << ":"
          << std::setw(2) << tm_time->tm_sec << ':';

  stream_ << log_severity_name(severity_);

  stream_ << ":" << filename << "(" << line << ")] ";

  message_start_ = stream_.str().length();
}

}  // namespace logging
}  // namespace debugrouter
