// Copyright 2026 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

#include "debug_router/native/log/logging.h"

#include "gtest/gtest.h"

namespace debugrouter {
namespace logging {
namespace {

TEST(LoggingTestSuite, DefaultInfoSkipsVerbosePayloadExpression) {
  const int previous_level = GetMinLogLevel();
  EXPECT_EQ(previous_level, LOG_INFO);
  int payload_expression_evaluations = 0;

  SetMinLogLevel(LOG_INFO);
  LOGV("protocol-payload-log-probe" << ++payload_expression_evaluations);
  EXPECT_EQ(payload_expression_evaluations, 0);

  SetMinLogLevel(LOG_VERBOSE);
  LOGV("protocol-payload-log-probe" << ++payload_expression_evaluations);
  EXPECT_EQ(payload_expression_evaluations, 1);

  SetMinLogLevel(previous_level);
}

}  // namespace
}  // namespace logging
}  // namespace debugrouter
