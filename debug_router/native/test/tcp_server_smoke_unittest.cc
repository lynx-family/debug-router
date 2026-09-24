// Copyright 2026 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

#include <memory>
#include <string>

#include "debug_router/native/socket/tcp_server.h"
#include "gtest/gtest.h"

namespace debugrouter {
namespace socket_server {
namespace {

class NoopTcpServerListener final : public TcpServerConnectionListener {
 public:
  void OnInit(int32_t, const std::string&) override {}
  void OnStatusChanged(const std::shared_ptr<TcpConnection>&, ConnectionStatus,
                       int32_t, const std::string&) override {
  }
  void OnMessage(const std::shared_ptr<TcpConnection>&,
                 const std::string&) override {}
};

TEST(TcpServerSmokeTestSuite,
     ConstructAndImmediateDestroyWithoutStartDoesNotCrash) {
  ASSERT_EXIT(
      {
        auto listener = std::make_shared<NoopTcpServerListener>();
        auto server = TcpServer::CreateTcpServer(listener);
        server.reset();
        _exit(0);
      },
      ::testing::ExitedWithCode(0), "");
}

}  // namespace
}  // namespace socket_server
}  // namespace debugrouter
