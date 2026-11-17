// Copyright 2026 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

#include "debug_router/native/protocol/protocol.h"

#include <string>
#include <utility>

#include "gtest/gtest.h"
#include "json/reader.h"

namespace debugrouter {
namespace protocol {
namespace {

TEST(ProtocolVersionTest, NegotiatesLegacyAndCompatibleVersions) {
  Json::Value init(Json::objectValue);
  init["event"] = "Initialize";
  init["data"] = 12;

  auto legacy = RemoteDebugProtocol::Parse(init);
  ASSERT_NE(legacy, nullptr);
  EXPECT_FALSE(legacy->AsInit()->negotiated_version_);
  EXPECT_EQ(legacy->AsInit()->client_id_, 12u);

  const std::pair<std::string, ProtocolVersion> versions[] = {
      {"connector_1_0", {1, 0}},
      {"connector_2_0", {1, 0}},
      {"connector_0_9", {0, 9}},
  };
  for (const auto& [version, expected] : versions) {
    init["connector_version"] = version;
    auto body = RemoteDebugProtocol::Parse(init);
    ASSERT_NE(body, nullptr);
    ASSERT_TRUE(body->AsInit()->negotiated_version_);
    EXPECT_EQ(*body->AsInit()->negotiated_version_, expected);
  }
}

TEST(ProtocolVersionTest, RejectsInvalidConnectorVersions) {
  Json::Value init(Json::objectValue);
  init["event"] = "Initialize";
  init["data"] = 12;

  for (const auto& version :
       {"", "connector_1_x", "connector_4294967296_0", "connector_1_0_extra"}) {
    init["connector_version"] = version;
    EXPECT_EQ(RemoteDebugProtocol::Parse(init), nullptr);
  }

  init["connector_version"] = Json::Value();
  EXPECT_EQ(RemoteDebugProtocol::Parse(init), nullptr);
}

TEST(ProtocolVersionTest, OmitsUnnegotiatedVersionAndPreservesRegisterData) {
  auto body = RemoteDebugProtocol::CreateProtocolBody4Register(
      12, {{"App", "demo"}}, true);
  Json::Value message;
  ASSERT_TRUE(
      Json::Reader().parse(RemoteDebugProtocol::Stringify(body), message));

  EXPECT_EQ(message["event"].asString(), "Register");
  EXPECT_FALSE(message.isMember("sdk_version"));
  Json::Value expected_data(Json::objectValue);
  expected_data["id"] = 12;
  expected_data["type"] = "runtime";
  expected_data["reconnect"] = true;
  expected_data["info"]["App"] = "demo";
  EXPECT_EQ(message["data"], expected_data);
}

}  // namespace
}  // namespace protocol
}  // namespace debugrouter
