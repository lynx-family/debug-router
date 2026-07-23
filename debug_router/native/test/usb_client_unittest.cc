// Copyright 2026 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

#include "debug_router/native/socket/usb_client.h"

#include <sys/socket.h>
#include <unistd.h>

#include <atomic>
#include <chrono>
#include <condition_variable>
#include <memory>
#include <mutex>
#include <string>

#include "debug_router/native/core/util.h"
#include "gtest/gtest.h"

namespace debugrouter {
namespace socket_server {
namespace {

class CountingUsbClientListener final : public UsbClientListener {
 public:
  void OnOpen(std::shared_ptr<UsbClient> client, int32_t code,
              const std::string& reason) override {
    open_count.fetch_add(1, std::memory_order_relaxed);
    cv.notify_all();
  }

  void OnClose(std::shared_ptr<UsbClient> client, int32_t code,
               const std::string& reason) override {
    close_count.fetch_add(1, std::memory_order_relaxed);
    cv.notify_all();
  }

  void OnError(std::shared_ptr<UsbClient> client, int32_t code,
               const std::string& message) override {
    error_count.fetch_add(1, std::memory_order_relaxed);
    cv.notify_all();
  }

  void OnMessage(std::shared_ptr<UsbClient> client,
                 const std::string& message) override {
    message_count.fetch_add(1, std::memory_order_relaxed);
    cv.notify_all();
  }

  bool WaitForCount(const std::atomic<int>& counter, int expected_count,
                    int timeout_ms) {
    std::unique_lock<std::mutex> lock(mutex);
    return cv.wait_for(lock, std::chrono::milliseconds(timeout_ms), [&]() {
      return counter.load(std::memory_order_relaxed) >= expected_count;
    });
  }

  std::mutex mutex;
  std::condition_variable cv;
  std::atomic<int> open_count{0};
  std::atomic<int> close_count{0};
  std::atomic<int> error_count{0};
  std::atomic<int> message_count{0};
};

std::string PackFrame(const std::string& message) {
  const uint32_t total_size =
      static_cast<uint32_t>(kFrameHeaderLen + kPayloadSizeLen + message.size());
  const uint32_t payload_block_size =
      static_cast<uint32_t>(kPayloadSizeLen + message.size());
  std::string result(total_size, '\0');
  char char_array[4];
  util::IntToCharArray(kFrameProtocolVersion, char_array);
  memcpy(&result[0], char_array, 4);
  util::IntToCharArray(kPTFrameTypeTextMessage, char_array);
  memcpy(&result[4], char_array, 4);
  util::IntToCharArray(kFrameDefaultTag, char_array);
  memcpy(&result[8], char_array, 4);
  util::IntToCharArray(payload_block_size, char_array);
  memcpy(&result[12], char_array, 4);
  util::IntToCharArray(static_cast<uint32_t>(message.size()), char_array);
  memcpy(&result[16], char_array, 4);
  memcpy(&result[20], message.data(), message.size());
  return result;
}

TEST(UsbClientTestSuite, CloseBeforeOpenDoesNotNotifyListener) {
  auto client = std::make_shared<UsbClient>(kInvalidSocket);
  auto listener = std::make_shared<CountingUsbClientListener>();
  client->SetListenerForTest(listener);

  client->NotifyCloseForTest(0, "before open");

  EXPECT_EQ(listener->close_count.load(std::memory_order_relaxed), 0);
  EXPECT_EQ(listener->error_count.load(std::memory_order_relaxed), 0);
}

TEST(UsbClientTestSuite, CloseAfterOpenNotifiesOnlyOnce) {
  auto client = std::make_shared<UsbClient>(kInvalidSocket);
  auto listener = std::make_shared<CountingUsbClientListener>();
  client->SetListenerForTest(listener);
  client->SetConnectedForTest(true);

  client->NotifyCloseForTest(0, "after open");
  client->NotifyCloseForTest(0, "after open again");

  EXPECT_EQ(listener->close_count.load(std::memory_order_relaxed), 1);
  EXPECT_EQ(listener->error_count.load(std::memory_order_relaxed), 0);
}

TEST(UsbClientTestSuite, PeerEOFNotifiesCloseWithoutError) {
  int sockets[2] = {-1, -1};
  ASSERT_EQ(socketpair(AF_UNIX, SOCK_STREAM, 0, sockets), 0);

  auto client = std::make_shared<UsbClient>(sockets[0]);
  auto listener = std::make_shared<CountingUsbClientListener>();
  client->Init();
  client->StartUp(listener);

  const std::string frame = PackFrame(R"({"event":"Initialize","data":-1})");
  ASSERT_EQ(write(sockets[1], frame.data(), frame.size()),
            static_cast<ssize_t>(frame.size()));
  ASSERT_EQ(shutdown(sockets[1], SHUT_WR), 0);

  EXPECT_TRUE(listener->WaitForCount(listener->open_count, 1, 3000));
  EXPECT_TRUE(listener->WaitForCount(listener->message_count, 1, 3000));
  EXPECT_TRUE(listener->WaitForCount(listener->close_count, 1, 3000));
  EXPECT_EQ(listener->error_count.load(std::memory_order_relaxed), 0);

  close(sockets[1]);
  client->Stop();
}

}  // namespace
}  // namespace socket_server
}  // namespace debugrouter
