// Copyright 2023 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

#ifndef DEBUGROUTER_NATIVE_LOG_LOGGING_H_
#define DEBUGROUTER_NATIVE_LOG_LOGGING_H_

#include <memory>
#include <sstream>
#include <string>

namespace debugrouter {
namespace logging {
class LoggingDelegate;

enum LoggingDestination {
  LOG_NONE = 0,
  LOG_TO_FILE = 1 << 0,
  LOG_TO_SYSTEM_DEBUG_LOG = 1 << 1,

  LOG_TO_ALL = LOG_TO_FILE | LOG_TO_SYSTEM_DEBUG_LOG,

  LOG_DEFAULT = LOG_TO_SYSTEM_DEBUG_LOG,
};

void SetLoggingDelegate(std::unique_ptr<LoggingDelegate> delegate);

void SetMinLogLevel(int level);

int GetMinLogLevel();

int GetMinAllLogLevel();

#define DEBUGROUTER_LOG_LEVEL_VERBOSE -1
#define DEBUGROUTER_LOG_LEVEL_INFO 0
#define DEBUGROUTER_LOG_LEVEL_WARNING 1
#define DEBUGROUTER_LOG_LEVEL_ERROR 2
#define DEBUGROUTER_LOG_LEVEL_REPORT 3
#define DEBUGROUTER_LOG_LEVEL_FATAL 4
#define DEBUGROUTER_LOG_LEVEL_NUM 6

typedef int LogSeverity;
const LogSeverity LOG_VERBOSE = DEBUGROUTER_LOG_LEVEL_VERBOSE;
const LogSeverity LOG_INFO = DEBUGROUTER_LOG_LEVEL_INFO;
const LogSeverity LOG_WARNING = DEBUGROUTER_LOG_LEVEL_WARNING;
const LogSeverity LOG_ERROR = DEBUGROUTER_LOG_LEVEL_ERROR;
const LogSeverity LOG_REPORT = DEBUGROUTER_LOG_LEVEL_REPORT;
const LogSeverity LOG_FATAL = DEBUGROUTER_LOG_LEVEL_FATAL;
const LogSeverity LOG_NUM_SEVERITIES = DEBUGROUTER_LOG_LEVEL_NUM;

typedef int LogSource;
const LogSource LOG_SOURCE_NATIVE = 0;
const LogSource LOG_SOURCE_JS = 1;
// 2 is used for console.alog & console.report
const LogSource LOG_SOURCE_JS_EXT = 2;

// This class is used to explicitly ignore values in the conditional
// logging macros.  This avoids compiler warnings like "value computed
// is not used" and "statement has no effect".
class LogMessageVoidify {
 public:
  LogMessageVoidify() {}
  // This has to be an operator with a precedence lower than << but
  // higher than ?:
  void operator&(std::ostream &) {}
};

#define LOG_IS_ON(severity)                  \
  ((debugrouter::logging::LOG_##severity) >= \
   debugrouter::logging::GetMinAllLogLevel())

#define LOG_STREAM(severity)                                             \
  debugrouter::logging::LogMessage(__FILE__, __LINE__,                   \
                                   debugrouter::logging::LOG_##severity) \
      .stream()

#define JS_LOG_STREAM(severity, source, runtime_id)             \
  debugrouter::logging::LogMessage(                             \
      __FILE__, __LINE__, debugrouter::logging::LOG_##severity, \
      debugrouter::logging::LOG_SOURCE_JS, runtime_id)          \
      .stream()

#define JS_ALOG_STREAM(severity, source, runtime_id)            \
  debugrouter::logging::LogMessage(                             \
      __FILE__, __LINE__, debugrouter::logging::LOG_##severity, \
      debugrouter::logging::LOG_SOURCE_JS_EXT, runtime_id)      \
      .stream()

#define LAZY_STREAM(stream, condition) \
  !(condition) ? (void)0 : debugrouter::logging::LogMessageVoidify() & (stream)

// Use this macro to suppress warning if the variable in log is not used.
#define UNUSED_LOG_VARIABLE __attribute__((unused))

#ifndef DEBUGROUTER_MIN_LOG_LEVEL
#define DEBUGROUTER_MIN_LOG_LEVEL DEBUGROUTER_LOG_LEVEL_VERBOSE
#endif

#if DEBUGROUTER_MIN_LOG_LEVEL <= DEBUGROUTER_LOG_LEVEL_VERBOSE
#define LOGV(msg) LAZY_STREAM(LOG_STREAM(VERBOSE), LOG_IS_ON(VERBOSE)) << msg
#define DLOGV(msg) LAZY_STREAM(LOG_STREAM(VERBOSE), LOG_IS_ON(VERBOSE)) << msg
#else
#define LOGV(msg)
#define DLOGV(msg)
#endif

#if DEBUGROUTER_MIN_LOG_LEVEL <= DEBUGROUTER_LOG_LEVEL_INFO
#define LOGI(msg) LAZY_STREAM(LOG_STREAM(INFO), LOG_IS_ON(INFO)) << msg
#define DLOGI(msg) LAZY_STREAM(LOG_STREAM(INFO), LOG_IS_ON(INFO)) << msg
#else
#define LOGI(msg)
#define DLOGI(msg)
#endif

#if DEBUGROUTER_MIN_LOG_LEVEL <= DEBUGROUTER_LOG_LEVEL_WARNING
#define LOGW(msg) LAZY_STREAM(LOG_STREAM(WARNING), LOG_IS_ON(WARNING)) << msg
#define DLOGW(msg) LAZY_STREAM(LOG_STREAM(WARNING), LOG_IS_ON(WARNING)) << msg
#else
#define LOGW(msg)
#define DLOGW(msg)
#endif

#if DEBUGROUTER_MIN_LOG_LEVEL <= DEBUGROUTER_LOG_LEVEL_ERROR
#define LOGE(msg) LAZY_STREAM(LOG_STREAM(ERROR), LOG_IS_ON(ERROR)) << msg
#define DLOGE(msg) LAZY_STREAM(LOG_STREAM(ERROR), LOG_IS_ON(ERROR)) << msg
#else
#define LOGE(msg)
#define DLOGE(msg)
#endif

#if DEBUGROUTER_MIN_LOG_LEVEL <= DEBUGROUTER_LOG_LEVEL_FATAL
#define LOGF(msg) LAZY_STREAM(LOG_STREAM(FATAL), LOG_IS_ON(FATAL)) << msg
#define DLOGF(msg) LAZY_STREAM(LOG_STREAM(FATAL), LOG_IS_ON(FATAL)) << msg
#else
#define LOGF(msg)
#define DLOGF(msg)
#endif

#if DEBUGROUTER_MIN_LOG_LEVEL <= DEBUGROUTER_LOG_LEVEL_REPORT
#define LOGR(msg) LAZY_STREAM(LOG_STREAM(REPORT), LOG_IS_ON(REPORT)) << msg
#define DLOGR(msg) LAZY_STREAM(LOG_STREAM(REPORT), LOG_IS_ON(REPORT)) << msg
#else
#define LOGR(msg)
#define DLOGR(msg)
#endif

#define JSLOG(severity, runtime_id) \
  LAZY_STREAM(JS_LOG_STREAM(severity, JS, runtime_id), true)

#define JSALOG(severity, runtime_id) \
  LAZY_STREAM(JS_ALOG_STREAM(severity, JS, runtime_id), true)

#ifndef DCHECK
// for debug, if check failed, log fatal and abort
#ifndef NDEBUG
#define DCHECK(condition)                      \
  LAZY_STREAM(LOG_STREAM(FATAL), !(condition)) \
      << "Check failed: " #condition ". "
#else
// for release, do nothing
#define DCHECK(condition) !(condition) ? (void)0 : (void)0
#endif
#endif

#define NOTREACHED() LOGF("")

class LogMessage {
 public:
  LogMessage(const char *file, int line, LogSeverity severity, LogSource source,
             int64_t rt_id);
  LogMessage(const char *file, int line, LogSeverity severity);
  LogMessage(const char *file, int line, std::string *result);
  LogMessage(const char *file, int line, LogSeverity severity,
             std::string *result);
  ~LogMessage();
  std::ostringstream &stream() { return stream_; }
  LogSeverity severity() { return severity_; }
  LogSource source() { return source_; }
  size_t messageStart() { return message_start_; }
  int64_t runtimeId() { return runtime_id_; }

 private:
  void Init(const char *file, int line);

  LogSeverity severity_;
  std::ostringstream stream_;
  size_t message_start_;

  const char *file_;
  const int line_;
  LogSource source_;
  int64_t runtime_id_;
  LogMessage(const LogMessage &) = delete;
  LogMessage &operator=(const LogMessage &) = delete;
};

class LoggingDelegate {
 public:
  virtual ~LoggingDelegate() {}
  virtual void Log(LogMessage *msg) = 0;
};
}  // namespace logging
}  // namespace debugrouter

#endif  // DEBUGROUTER_NATIVE_LOG_LOGGING_H_
