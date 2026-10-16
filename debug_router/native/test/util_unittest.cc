// Copyright 2026 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

#include "debug_router/native/core/util.h"

#include "gtest/gtest.h"

namespace debugrouter {
namespace util {
namespace {

TEST(UtilTest, LogInitializeMessageAsInfo) {
  const std::string message = R"({
    "event":"Initialize",
    "data":-1
  })";

  EXPECT_EQ(VerboseMessageLogLevel::kInfo, GetVerboseMessageLogLevel(message));
}

TEST(UtilTest, LogCdpCustomizedMessage) {
  const std::string message = R"({
    "event":"Customized",
    "data":{
      "type":"CDP",
      "sender":8901,
      "data":{
        "client_id":8901,
        "session_id":0,
        "message":"{}"
      }
    }
  })";

  EXPECT_EQ(VerboseMessageLogLevel::kInfo, GetVerboseMessageLogLevel(message));
}

TEST(UtilTest, LogAppCustomizedMessage) {
  const std::string message = R"({
    "event":"Customized",
    "data":{
      "type":"App",
      "sender":8901,
      "data":{
        "client_id":8901,
        "session_id":0,
        "message":{
          "id":1,
          "method":"App.openPage",
          "params":{}
        }
      }
    }
  })";

  EXPECT_EQ(VerboseMessageLogLevel::kInfo, GetVerboseMessageLogLevel(message));
}

TEST(UtilTest, LogListSessionCustomizedMessageAsInfo) {
  const std::string message = R"({
    "event":"Customized",
    "data":{
      "type":"ListSession",
      "sender":8901,
      "data":{
        "client_id":8901
      }
    }
  })";

  EXPECT_EQ(VerboseMessageLogLevel::kInfo, GetVerboseMessageLogLevel(message));
}

TEST(UtilTest, LogBuiltinCustomizedMessage) {
  const std::string message = R"({
    "event":"Customized",
    "data":{
      "type":"OpenCard",
      "sender":8901,
      "data":{
        "type":"url",
        "url":"lynx://test"
      }
    }
  })";

  EXPECT_EQ(VerboseMessageLogLevel::kInfo, GetVerboseMessageLogLevel(message));
}

TEST(UtilTest, LogExtensionCustomizedMessageAsDebug) {
  const std::string message = R"({
    "event":"Customized",
    "data":{
      "type":"xdb_jsb",
      "sender":8901,
      "data":{
        "client_id":8901,
        "session_id":0,
        "message":"{}"
      }
    }
  })";

  EXPECT_EQ(VerboseMessageLogLevel::kDebug, GetVerboseMessageLogLevel(message));
}

TEST(UtilTest, LogExtensionWithNestedAllowlistedTextAsDebug) {
  const std::string message = R"({
    "event":"Customized",
    "data":{
      "type":"xdb_jsb",
      "sender":8901,
      "data":{
        "client_id":8901,
        "session_id":0,
        "message":"{\"type\":\"CDP\"}"
      }
    }
  })";

  EXPECT_EQ(VerboseMessageLogLevel::kDebug, GetVerboseMessageLogLevel(message));
}

TEST(UtilTest, DoNotLogExtensionPayloadDebugByDefault) {
  SetExtensionMessagePayloadDebugLogEnabled(false);
  const std::string message = R"({
    "event":"Customized",
    "data":{
      "type":"xdb_jsb"
    }
  })";

  EXPECT_FALSE(IsExtensionMessagePayloadDebugLogEnabled());
  EXPECT_FALSE(ShouldLogExtensionMessagePayloadAsDebug(message));
}

TEST(UtilTest, LogExtensionPayloadDebugWhenEnabled) {
  SetExtensionMessagePayloadDebugLogEnabled(true);
  const std::string message = R"({
    "event":"Customized",
    "data":{
      "type":"xdb_jsb"
    }
  })";

  EXPECT_TRUE(IsExtensionMessagePayloadDebugLogEnabled());
  EXPECT_TRUE(ShouldLogExtensionMessagePayloadAsDebug(message));
  SetExtensionMessagePayloadDebugLogEnabled(false);
}

TEST(UtilTest, LogInvalidJsonAsInfo) {
  EXPECT_EQ(VerboseMessageLogLevel::kInfo, GetVerboseMessageLogLevel("CDP"));
}

}  // namespace
}  // namespace util
}  // namespace debugrouter
