// Copyright 2026 The Lynx Authors. All rights reserved.
// Licensed under the Apache License, Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

#include <memory>
#include <string>
#include <unordered_map>
#include <vector>

#include "debug_router/native/processor/message_handler.h"
#include "debug_router/native/processor/processor.h"
#include "debug_router/native/protocol/protocol.h"
#include "gtest/gtest.h"

namespace debugrouter {
namespace protocol {

namespace {

class RecordingMessageHandler : public processor::MessageHandler {
 public:
  std::string GetRoomId() override { return "room"; }
  std::unordered_map<std::string, std::string> GetClientInfo() override {
    return {};
  }
  std::unordered_map<int, std::string> GetSessionList() override {
    return {{7, R"({"url":"lynx://page","type":"runtime"})"}};
  }
  std::unordered_map<int, std::string> GetSessionDebugRouterIds() override {
    return {{7, "50466240"}};
  }
  void OnMessage(const std::string &, int, const std::string &) override {}
  void SendMessage(const std::string &message) override {
    messages_.push_back(message);
  }
  void OpenCard(const std::string &) override {}
  std::string HandleAppAction(const std::string &,
                              const std::string &) override {
    return {};
  }
  void ChangeRoomServer(const std::string &, const std::string &) override {}
  void ReportError(const std::string &) override {}

  std::vector<std::string> messages_;
};

}  // namespace

TEST(UpdateSessionDebugRouterIdTest, StringifiesDedicatedPayload) {
  auto update = std::make_shared<CustomData4UpdateSessionDebugRouterId>();
  update->session_id_ = 7;
  update->session_debug_router_id_ = "50466240";

  auto body = RemoteDebugProtocol::CreateProtocolBody4Custom(
      kRemoteDebugProtocolBodyData4Custom4UpdateSessionDebugRouterId, 123,
      update);
  Json::Value root;
  Json::Reader reader;
  ASSERT_TRUE(reader.parse(RemoteDebugProtocol::Stringify(body), root));

  EXPECT_EQ(root[kKeyEvent].asString(), kRemoteDebugServerEvent4Custom);
  EXPECT_EQ(root[kKeyData][kKeyType].asString(),
            kRemoteDebugProtocolBodyData4Custom4UpdateSessionDebugRouterId);
  EXPECT_EQ(root[kKeyData][kKeySender].asInt(), 123);
  EXPECT_EQ(root[kKeyData][kKeyData][kKeySessionId].asInt(), 7);
  EXPECT_EQ(root[kKeyData][kKeyData][kKeySessionDebugRouterId].asString(),
            "50466240");
}

TEST(UpdateSessionDebugRouterIdTest, SessionListKeepsOriginalShape) {
  auto session = std::make_shared<SessionInfo>();
  session->session_id_ = 7;
  session->url_ = "lynx://page";
  session->type_ = "runtime";
  auto session_list = std::make_shared<CustomData4SessionList>();
  session_list->list_.push_back(session);

  auto body = RemoteDebugProtocol::CreateProtocolBody4Custom(
      kRemoteDebugProtocolBodyData4Custom4SessionList, 123, session_list);
  Json::Value root;
  Json::Reader reader;
  ASSERT_TRUE(reader.parse(RemoteDebugProtocol::Stringify(body), root));

  const Json::Value &item = root[kKeyData][kKeyData][0];
  EXPECT_EQ(item.size(), 3U);
  EXPECT_TRUE(item.isMember(kKeySessionId));
  EXPECT_TRUE(item.isMember(kKeyUrl));
  EXPECT_TRUE(item.isMember(kKeyType));
}

TEST(UpdateSessionDebugRouterIdTest, FlushesIdsBeforeSessionList) {
  auto handler = std::make_unique<RecordingMessageHandler>();
  RecordingMessageHandler *handler_ptr = handler.get();
  processor::Processor processor(std::move(handler));

  processor.FlushSessionList();

  ASSERT_EQ(handler_ptr->messages_.size(), 2U);
  Json::Reader reader;
  Json::Value id_update;
  Json::Value session_list;
  ASSERT_TRUE(reader.parse(handler_ptr->messages_[0], id_update));
  ASSERT_TRUE(reader.parse(handler_ptr->messages_[1], session_list));
  EXPECT_EQ(id_update[kKeyData][kKeyType].asString(),
            kRemoteDebugProtocolBodyData4Custom4UpdateSessionDebugRouterId);
  EXPECT_EQ(session_list[kKeyData][kKeyType].asString(),
            kRemoteDebugProtocolBodyData4Custom4SessionList);
}

}  // namespace protocol
}  // namespace debugrouter
