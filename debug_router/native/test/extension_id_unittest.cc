// Copyright 2025 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

#include "debug_router/native/protocol/protocol.h"

#include "gtest/gtest.h"
#include "json/json.h"

namespace debugrouter {
namespace protocol {
namespace {

// Test that extension message (e.g. GetGlobalSwitch) with id is parsed
// correctly via the CDP/extension fallback path.
TEST(ExtensionIdTestSuite, ParseExtensionWithId) {
  Json::Value root;
  root[kKeyEvent] = kRemoteDebugServerEvent4Custom;
  Json::Value data(Json::objectValue);
  data[kKeyType] = "GetGlobalSwitch";
  data[kKeySender] = 1;
  data[kKeyId] = 77;
  Json::Value payload(Json::objectValue);
  payload[kKeyClientId] = 100;
  payload[kKeySessionId] = 5;
  payload[kKeyMessage] = "{\"global_key\":\"enable_devtool\"}";
  data[kKeyData] = payload;
  root[kKeyData] = data;

  auto body = RemoteDebugProtocol::Parse(root);
  ASSERT_NE(body, nullptr);
  EXPECT_TRUE(body->IsProtocolBody4Custom());
  auto custom = body->AsCustom();
  EXPECT_EQ(custom->id_, 77);
  EXPECT_EQ(custom->type_, "GetGlobalSwitch");
}

// Test that extension message without id defaults to -1.
TEST(ExtensionIdTestSuite, ParseExtensionWithoutId) {
  Json::Value root;
  root[kKeyEvent] = kRemoteDebugServerEvent4Custom;
  Json::Value data(Json::objectValue);
  data[kKeyType] = "SetGlobalSwitch";
  data[kKeySender] = 1;
  // No "id" field
  Json::Value payload(Json::objectValue);
  payload[kKeyClientId] = 100;
  payload[kKeySessionId] = 5;
  payload[kKeyMessage] = "{\"global_key\":\"enable_devtool\",\"global_value\":true}";
  data[kKeyData] = payload;
  root[kKeyData] = data;

  auto body = RemoteDebugProtocol::Parse(root);
  ASSERT_NE(body, nullptr);
  auto custom = body->AsCustom();
  EXPECT_EQ(custom->id_, -1);
}

// Test that Stringify emits id for extension messages when id >= 0.
TEST(ExtensionIdTestSuite, StringifyExtensionWithId) {
  std::shared_ptr<CustomData4CDP> cdp_data =
      std::make_shared<CustomData4CDP>();
  cdp_data->client_id_ = 100;
  cdp_data->session_id_ = 5;
  cdp_data->message_ = "{\"global_value\":true}";
  cdp_data->is_object_ = false;

  auto body = RemoteDebugProtocol::CreateProtocolBody4Custom(
      "GetGlobalSwitch", 1, cdp_data);
  body->AsCustom()->id_ = 77;

  std::string result = RemoteDebugProtocol::Stringify(body);

  Json::Reader reader;
  Json::Value parsed;
  ASSERT_TRUE(reader.parse(result, parsed));
  EXPECT_EQ(parsed[kKeyData][kKeyId].asInt(), 77);
  EXPECT_EQ(parsed[kKeyData][kKeyType].asString(), "GetGlobalSwitch");
}

// Test that Stringify does NOT emit id when it is -1 (default).
TEST(ExtensionIdTestSuite, StringifyExtensionWithoutId) {
  std::shared_ptr<CustomData4CDP> cdp_data =
      std::make_shared<CustomData4CDP>();
  cdp_data->client_id_ = 100;
  cdp_data->session_id_ = 5;
  cdp_data->message_ = "{\"global_value\":true}";
  cdp_data->is_object_ = false;

  auto body = RemoteDebugProtocol::CreateProtocolBody4Custom(
      "SetGlobalSwitch", 1, cdp_data);
  // id_ defaults to -1, should not be emitted.

  std::string result = RemoteDebugProtocol::Stringify(body);

  Json::Reader reader;
  Json::Value parsed;
  ASSERT_TRUE(reader.parse(result, parsed));
  EXPECT_FALSE(parsed[kKeyData].isMember(kKeyId));
}

}  // namespace
}  // namespace protocol
}  // namespace debugrouter
