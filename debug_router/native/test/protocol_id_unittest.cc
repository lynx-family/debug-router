// Copyright 2025 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

#include "debug_router/native/protocol/protocol.h"

#include "gtest/gtest.h"
#include "json/json.h"

namespace debugrouter {
namespace protocol {
namespace {

// Test that ListSession request with id is parsed correctly.
TEST(ProtocolIdTestSuite, ParseListSessionWithId) {
  Json::Value root;
  root[kKeyEvent] = kRemoteDebugServerEvent4Custom;
  Json::Value data(Json::objectValue);
  data[kKeyType] = kRemoteDebugProtocolBodyData4Custom4ListSession;
  data[kKeySender] = 1;
  data[kKeyId] = 42;
  Json::Value payload(Json::objectValue);
  payload[kKeyClientId] = 100;
  data[kKeyData] = payload;
  root[kKeyData] = data;

  auto body = RemoteDebugProtocol::Parse(root);
  ASSERT_NE(body, nullptr);
  EXPECT_TRUE(body->IsProtocolBody4Custom());
  auto custom = body->AsCustom();
  EXPECT_TRUE(custom->Is4ListSession());
  EXPECT_EQ(custom->id_, 42);
}

// Test that ListSession request without id defaults to -1.
TEST(ProtocolIdTestSuite, ParseListSessionWithoutId) {
  Json::Value root;
  root[kKeyEvent] = kRemoteDebugServerEvent4Custom;
  Json::Value data(Json::objectValue);
  data[kKeyType] = kRemoteDebugProtocolBodyData4Custom4ListSession;
  data[kKeySender] = 1;
  // No "id" field
  Json::Value payload(Json::objectValue);
  payload[kKeyClientId] = 100;
  data[kKeyData] = payload;
  root[kKeyData] = data;

  auto body = RemoteDebugProtocol::Parse(root);
  ASSERT_NE(body, nullptr);
  auto custom = body->AsCustom();
  EXPECT_TRUE(custom->Is4ListSession());
  EXPECT_EQ(custom->id_, -1);
}

// Test that SessionList response with id serializes the id field.
TEST(ProtocolIdTestSuite, StringifySessionListWithId) {
  auto session_list = std::make_shared<CustomData4SessionList>();
  auto session = std::make_shared<SessionInfo>();
  session->session_id_ = 1;
  session->url_ = "http://example.com";
  session->type_ = "web";
  session_list->list_.push_back(session);

  auto body = RemoteDebugProtocol::CreateProtocolBody4Custom(
      kRemoteDebugProtocolBodyData4Custom4SessionList, 10,
      std::move(session_list));
  body->AsCustom()->id_ = 42;

  std::string result = RemoteDebugProtocol::Stringify(body);

  Json::Reader reader;
  Json::Value parsed;
  ASSERT_TRUE(reader.parse(result, parsed));
  EXPECT_EQ(parsed[kKeyData][kKeyId].asInt(), 42);
  EXPECT_EQ(parsed[kKeyData][kKeyType].asString(),
            kRemoteDebugProtocolBodyData4Custom4SessionList);
}

// Test that SessionList response without id does NOT emit the id field.
TEST(ProtocolIdTestSuite, StringifySessionListWithoutId) {
  auto session_list = std::make_shared<CustomData4SessionList>();

  auto body = RemoteDebugProtocol::CreateProtocolBody4Custom(
      kRemoteDebugProtocolBodyData4Custom4SessionList, 10,
      std::move(session_list));
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
