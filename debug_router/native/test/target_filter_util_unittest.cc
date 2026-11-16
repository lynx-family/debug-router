// Copyright 2026 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

#include "debug_router/native/core/target_filter_util.h"

#include "gtest/gtest.h"

namespace debugrouter {
namespace core {
namespace internal {
namespace {

TEST(TargetFilterUtilTest, ExtractTargetIdFromCustomizedPayload) {
  const std::string message = R"({
    "event":"Customized",
    "data":{
      "type":"CDP",
      "sender":1,
      "data":{
        "session_id":42,
        "client_id":1,
        "message":"{}"
      }
    }
  })";

  int32_t target_id = -1;
  EXPECT_TRUE(ExtractIncomingTargetIdForFilter(message, target_id));
  EXPECT_EQ(target_id, 42);
}

TEST(TargetFilterUtilTest, IgnoreTargetListControlMessage) {
  const std::string message = R"({
    "event":"Customized",
    "data":{
      "type":"SessionList",
      "sender":1,
      "data":[
        {"session_id":42,"url":"test","type":"lynx"}
      ]
    }
  })";

  int32_t target_id = -1;
  EXPECT_FALSE(ExtractIncomingTargetIdForFilter(message, target_id));
  EXPECT_EQ(target_id, -1);
}

TEST(TargetFilterUtilTest, IgnoreNegativeTargetId) {
  const std::string message = R"({
    "event":"Customized",
    "data":{
      "type":"CDP",
      "sender":1,
      "data":{
        "session_id":-1,
        "client_id":1,
        "message":"{}"
      }
    }
  })";

  int32_t target_id = -1;
  EXPECT_FALSE(ExtractIncomingTargetIdForFilter(message, target_id));
  EXPECT_EQ(target_id, -1);
}

TEST(TargetFilterUtilTest, IgnoreZeroTargetId) {
  const std::string message = R"({
    "event":"Customized",
    "data":{
      "type":"CDP",
      "sender":1,
      "data":{
        "session_id":0,
        "client_id":1,
        "message":"{}"
      }
    }
  })";

  int32_t target_id = -1;
  EXPECT_FALSE(ExtractIncomingTargetIdForFilter(message, target_id));
  EXPECT_EQ(target_id, 0);
}

TEST(TargetFilterUtilTest, IgnoreStringLiteralTargetIdInMessageBody) {
  const std::string message = R"({
    "event":"Customized",
    "data":{
      "type":"CDP",
      "sender":1,
      "data":{
        "client_id":1,
        "message":"WARN: \"session_id\":42 missing"
      }
    }
  })";

  int32_t target_id = -1;
  EXPECT_FALSE(ExtractIncomingTargetIdForFilter(message, target_id));
  EXPECT_EQ(target_id, -1);
}

TEST(TargetFilterUtilTest, IgnoreNonNumericTargetId) {
  const std::string message = R"({
    "event":"Customized",
    "data":{
      "type":"CDP",
      "sender":1,
      "data":{
        "session_id":"42",
        "client_id":1,
        "message":"{}"
      }
    }
  })";

  int32_t target_id = -1;
  EXPECT_FALSE(ExtractIncomingTargetIdForFilter(message, target_id));
  EXPECT_EQ(target_id, -1);
}

}  // namespace
}  // namespace internal
}  // namespace core
}  // namespace debugrouter
