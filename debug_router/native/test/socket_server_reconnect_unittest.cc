// Copyright 2026 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

#include <arpa/inet.h>
#include <netinet/in.h>
#include <sys/socket.h>
#include <unistd.h>

#include <chrono>
#include <condition_variable>
#include <mutex>
#include <string>
#include <vector>

#include "debug_router/native/core/debug_router_core.h"
#include "debug_router/native/core/util.h"
#include "debug_router/native/socket/socket_server_api.h"
#include "debug_router/native/socket/socket_server_type.h"
#include "gtest/gtest.h"

namespace debugrouter {
namespace socket_server {
namespace {

class RecordingListener : public SocketServerConnectionListener {
 public:
  void OnInit(int32_t code, const std::string& info) override {
    std::lock_guard<std::mutex> lock(mutex_);
    init_code_ = code;
    init_info_ = info;
    init_count_++;
    cv_.notify_all();
  }

  void OnStatusChanged(ConnectionStatus status, int32_t code,
                       const std::string& info) override {
    std::lock_guard<std::mutex> lock(mutex_);
    statuses_.push_back(status);
    cv_.notify_all();
  }

  void OnMessage(const std::string& message) override {
    std::lock_guard<std::mutex> lock(mutex_);
    messages_.push_back(message);
    cv_.notify_all();
  }

  int WaitForInit() {
    std::unique_lock<std::mutex> lock(mutex_);
    cv_.wait_for(lock, std::chrono::seconds(3),
                 [this] { return init_count_ > 0; });
    return init_code_;
  }

  std::string init_info() {
    std::lock_guard<std::mutex> lock(mutex_);
    return init_info_;
  }

  bool WaitForMessageCount(size_t count) {
    std::unique_lock<std::mutex> lock(mutex_);
    return cv_.wait_for(lock, std::chrono::seconds(3),
                        [this, count] { return messages_.size() >= count; });
  }

  bool WaitForStatusCount(size_t count) {
    std::unique_lock<std::mutex> lock(mutex_);
    return cv_.wait_for(lock, std::chrono::milliseconds(500),
                        [this, count] { return statuses_.size() >= count; });
  }

  size_t status_count() {
    std::lock_guard<std::mutex> lock(mutex_);
    return statuses_.size();
  }

 private:
  std::mutex mutex_;
  std::condition_variable cv_;
  int init_count_ = 0;
  int32_t init_code_ = -1;
  std::string init_info_;
  std::vector<ConnectionStatus> statuses_;
  std::vector<std::string> messages_;
};

class TestSocketServer : public SocketServer {
 public:
  explicit TestSocketServer(
      const std::shared_ptr<SocketServerConnectionListener>& listener)
      : SocketServer(listener) {}

  void SetCurrentClient(const std::shared_ptr<UsbClient>& client) {
    usb_client_ = client;
  }

 private:
  void Start() override {}
  int GetErrorMessage() override { return 0; }
  void CloseSocket(int socket_fd) override {}
};

int ParsePort(const std::string& info) {
  const std::string prefix = "port:";
  auto pos = info.find(prefix);
  if (pos == std::string::npos) {
    return kInvalidPort;
  }
  return std::stoi(info.substr(pos + prefix.size()));
}

int ConnectToPort(int port) {
  int fd = socket(AF_INET, SOCK_STREAM, 0);
  if (fd < 0) {
    return fd;
  }

  sockaddr_in addr;
  memset(&addr, 0, sizeof(addr));
  addr.sin_family = AF_INET;
  addr.sin_port = htons(port);
  addr.sin_addr.s_addr = htonl(INADDR_LOOPBACK);

  for (int i = 0; i < 50; ++i) {
    if (connect(fd, reinterpret_cast<sockaddr*>(&addr), sizeof(addr)) == 0) {
      return fd;
    }
    usleep(20 * 1000);
  }

  close(fd);
  return -1;
}

std::string WrapFrame(const std::string& message) {
  const uint32_t total_size =
      static_cast<uint32_t>(kFrameHeaderLen + kPayloadSizeLen + message.size());
  std::string result(total_size, '\0');
  char* buffer = &result[0];
  char char_array[4];

  util::IntToCharArray(kFrameProtocolVersion, char_array);
  memcpy(buffer, char_array, 4);
  util::IntToCharArray(kPTFrameTypeTextMessage, char_array);
  memcpy(buffer + 4, char_array, 4);
  util::IntToCharArray(kFrameDefaultTag, char_array);
  memcpy(buffer + 8, char_array, 4);
  util::IntToCharArray(static_cast<uint32_t>(message.size() + kPayloadSizeLen),
                       char_array);
  memcpy(buffer + 12, char_array, 4);
  util::IntToCharArray(static_cast<uint32_t>(message.size()), char_array);
  memcpy(buffer + 16, char_array, 4);
  memcpy(buffer + 20, message.c_str(), message.size());

  return result;
}

void SendFrame(int fd, const std::string& message) {
  std::string frame = WrapFrame(message);
  const char* data = frame.data();
  size_t remaining = frame.size();
  while (remaining > 0) {
    ssize_t sent = send(fd, data, remaining, 0);
    ASSERT_GT(sent, 0);
    data += sent;
    remaining -= static_cast<size_t>(sent);
  }
}

TEST(SocketServerReconnectTest, AcceptsNextShortConnectionAfterPreviousEof) {
  static_cast<void>(core::DebugRouterCore::GetInstance());

  auto listener = std::make_shared<RecordingListener>();
  auto server = SocketServer::CreateSocketServer(listener);
  server->Init();
  server->StartServer();

  ASSERT_EQ(listener->WaitForInit(), 0);
  int port = ParsePort(listener->init_info());
  ASSERT_NE(port, kInvalidPort);

  for (int i = 0; i < 20; ++i) {
    int fd = ConnectToPort(port);
    ASSERT_GE(fd, 0);
    SendFrame(fd, "{\"event\":\"Initialize\",\"data\":" + std::to_string(i) +
                      "}");
    ASSERT_TRUE(listener->WaitForMessageCount(static_cast<size_t>(i + 1)))
        << "socket server stopped accepting short connection #" << i;
    close(fd);
  }

  server->StopServer();
}

TEST(SocketServerReconnectTest, IgnoresCloseFromReplacedClient) {
  static_cast<void>(core::DebugRouterCore::GetInstance());

  auto listener = std::make_shared<RecordingListener>();
  // SocketServer's base destructor calls a virtual CloseSocket(); keep this fake
  // server alive for the process so the test only covers close-event routing.
  auto server =
      std::shared_ptr<TestSocketServer>(new TestSocketServer(listener),
                                        [](TestSocketServer*) {});
  auto old_client = std::make_shared<UsbClient>(kInvalidSocket);
  auto new_client = std::make_shared<UsbClient>(kInvalidSocket);
  server->SetCurrentClient(new_client);

  server->HandleOnCloseStatus(old_client, kDisconnected, 0,
                              "old client finished");

  // The old client is no longer active, so its close callback is stale cleanup
  // only. Reporting a status here would make the upper layer treat the current
  // client as disconnected.
  EXPECT_FALSE(listener->WaitForStatusCount(1));
  EXPECT_EQ(static_cast<size_t>(0), listener->status_count());
}

}  // namespace
}  // namespace socket_server
}  // namespace debugrouter
