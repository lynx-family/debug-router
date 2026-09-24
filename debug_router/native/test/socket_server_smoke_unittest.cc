// Copyright 2026 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

#include <memory>
#include <string>

#include "debug_router/native/socket/socket_server_api.h"
#include "gtest/gtest.h"

namespace debugrouter {
namespace socket_server {
namespace {

class NoopSocketServerListener final : public SocketServerConnectionListener {
 public:
  void OnInit(int32_t, const std::string&) override {}
  void OnStatusChanged(const std::shared_ptr<UsbClient>&, ConnectionStatus,
                       int32_t, const std::string&) override {
  }
  void OnMessage(const std::shared_ptr<UsbClient>&,
                 const std::string&) override {}
};

TEST(SocketServerSmokeTestSuite,
     ConstructAndImmediateDestroyWithoutStartDoesNotCrash) {
  ASSERT_EXIT(
      {
        auto listener = std::make_shared<NoopSocketServerListener>();
        auto server = SocketServer::CreateSocketServer(listener);
        server.reset();
        _exit(0);
      },
      ::testing::ExitedWithCode(0), "");
}

}  // namespace
}  // namespace socket_server
}  // namespace debugrouter
