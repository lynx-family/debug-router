// Copyright 2026 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

#ifndef _WIN32

#include "debug_router/native/socket/usb_client.h"

#include <sys/socket.h>

#include <cerrno>
#include <chrono>
#include <condition_variable>
#include <cstdint>
#include <cstring>
#include <memory>
#include <mutex>
#include <string>
#include <utility>

#include "debug_router/native/base/socket_guard.h"
#include "debug_router/native/core/util.h"
#include "debug_router/native/socket/usb_client_listener.h"
#include "gtest/gtest.h"

namespace debugrouter {
namespace socket_server {

class UsbClientTestPeer {
 public:
  static std::pair<bool, int32_t> ReadOneByte(UsbClient& client) {
    char byte = 0;
    const UsbClient::ReadOutcome outcome = client.Read(&byte, 1);
    return {outcome.result == UsbClient::ReadResult::kError,
            outcome.error_code};
  }
};

namespace {

using namespace std::chrono_literals;

class RecordingUsbClientListener final : public UsbClientListener {
 public:
  void OnOpen(std::shared_ptr<UsbClient>, int32_t,
              const std::string&) override {
    std::lock_guard<std::mutex> lock(mutex_);
    ++open_count_;
    condition_.notify_all();
  }

  void OnClose(std::shared_ptr<UsbClient>, int32_t code,
               const std::string& reason) override {
    std::lock_guard<std::mutex> lock(mutex_);
    ++close_count_;
    close_code_ = code;
    close_reason_ = reason;
    condition_.notify_all();
  }

  void OnError(std::shared_ptr<UsbClient>, int32_t code,
               const std::string& message) override {
    std::lock_guard<std::mutex> lock(mutex_);
    ++error_count_;
    error_code_ = code;
    error_message_ = message;
    condition_.notify_all();
  }

  void OnMessage(std::shared_ptr<UsbClient>, const std::string&) override {
    std::lock_guard<std::mutex> lock(mutex_);
    ++message_count_;
    condition_.notify_all();
  }

  bool WaitForMessage() {
    std::unique_lock<std::mutex> lock(mutex_);
    return condition_.wait_for(lock, 2s, [this] { return message_count_ > 0; });
  }

  bool WaitForClose() {
    std::unique_lock<std::mutex> lock(mutex_);
    return condition_.wait_for(lock, 2s, [this] { return close_count_ > 0; });
  }

  bool WaitForError() {
    std::unique_lock<std::mutex> lock(mutex_);
    return condition_.wait_for(lock, 2s, [this] { return error_count_ > 0; });
  }

  int error_count() {
    std::lock_guard<std::mutex> lock(mutex_);
    return error_count_;
  }

  int open_count() {
    std::lock_guard<std::mutex> lock(mutex_);
    return open_count_;
  }

  int error_code() {
    std::lock_guard<std::mutex> lock(mutex_);
    return error_code_;
  }

  int close_count() {
    std::lock_guard<std::mutex> lock(mutex_);
    return close_count_;
  }

  int close_code() {
    std::lock_guard<std::mutex> lock(mutex_);
    return close_code_;
  }

  std::string close_reason() {
    std::lock_guard<std::mutex> lock(mutex_);
    return close_reason_;
  }

  std::string error_message() {
    std::lock_guard<std::mutex> lock(mutex_);
    return error_message_;
  }

 private:
  std::mutex mutex_;
  std::condition_variable condition_;
  int close_count_ = 0;
  int error_count_ = 0;
  int message_count_ = 0;
  int open_count_ = 0;
  int close_code_ = -1;
  int error_code_ = -1;
  std::string close_reason_;
  std::string error_message_;
};

class UsbClientTest : public testing::Test {
 protected:
  void SetUp() override {
    ASSERT_EQ(socketpair(AF_UNIX, SOCK_STREAM, 0, sockets_), 0);
    client_ = std::make_shared<UsbClient>(sockets_[0]);
    peer_ = std::make_unique<base::SocketGuard>(sockets_[1]);
    listener_ = std::make_shared<RecordingUsbClientListener>();
    client_->Init();
    client_->StartUp(listener_);
  }

  void TearDown() override {
    peer_->Reset();
    client_->Stop();
  }

  void EstablishConnection() {
    SendAll(BuildFrame("{}"));
    ASSERT_TRUE(listener_->WaitForMessage());
  }

  void SendThenFinish(const std::string& data) {
    SendAll(data);
    ASSERT_EQ(shutdown(peer_->Get(), SHUT_WR), 0);
  }

  static std::string BuildFrame(const std::string& payload) {
    std::string frame(kFrameHeaderLen + kPayloadSizeLen + payload.size(), '\0');
    char encoded[4];
    util::IntToCharArray(kFrameProtocolVersion, encoded);
    memcpy(frame.data(), encoded, 4);
    util::IntToCharArray(kPTFrameTypeTextMessage, encoded);
    memcpy(frame.data() + 4, encoded, 4);
    util::IntToCharArray(kFrameDefaultTag, encoded);
    memcpy(frame.data() + 8, encoded, 4);
    util::IntToCharArray(
        static_cast<uint32_t>(kPayloadSizeLen + payload.size()), encoded);
    memcpy(frame.data() + 12, encoded, 4);
    util::IntToCharArray(static_cast<uint32_t>(payload.size()), encoded);
    memcpy(frame.data() + kFrameHeaderLen, encoded, 4);
    memcpy(frame.data() + kFrameHeaderLen + kPayloadSizeLen, payload.data(),
           payload.size());
    return frame;
  }

  void SendAll(const std::string& data) {
    size_t sent = 0;
    while (sent < data.size()) {
      const auto result = base::SendNoSigPipe(peer_->Get(), data.data() + sent,
                                              data.size() - sent);
      ASSERT_GT(result, 0);
      sent += static_cast<size_t>(result);
    }
  }

  int sockets_[2] = {-1, -1};
  std::shared_ptr<UsbClient> client_;
  std::unique_ptr<base::SocketGuard> peer_;
  std::shared_ptr<RecordingUsbClientListener> listener_;
};

TEST_F(UsbClientTest, EofAtNextFrameBoundaryIsCleanClose) {
  EstablishConnection();

  ASSERT_EQ(shutdown(peer_->Get(), SHUT_WR), 0);

  ASSERT_TRUE(listener_->WaitForClose());
  EXPECT_EQ(listener_->error_count(), 0);
  EXPECT_EQ(listener_->close_code(), 0);
  EXPECT_EQ(listener_->close_reason(), "peer closed connection");
}

TEST_F(UsbClientTest, EofBeforeFirstFrameIsConnectionError) {
  ASSERT_EQ(shutdown(peer_->Get(), SHUT_WR), 0);

  ASSERT_TRUE(listener_->WaitForError());
  EXPECT_EQ(listener_->error_code(), 0);
  EXPECT_EQ(listener_->error_message(), "peer closed before protocol frame");
  EXPECT_EQ(listener_->close_count(), 0);
}

TEST_F(UsbClientTest, InvalidHeaderBeforeFirstFrameIsConnectionError) {
  std::string frame = BuildFrame("first");
  frame[0] = static_cast<char>(0x7f);

  SendThenFinish(frame);

  ASSERT_TRUE(listener_->WaitForError());
  EXPECT_EQ(listener_->error_code(), 0);
  EXPECT_EQ(
      listener_->error_message(),
      "ReadAndCheckMessageHeader error: don't match DebugRouter protocol");
  EXPECT_EQ(listener_->close_count(), 0);
}

TEST_F(UsbClientTest, PartialHeaderEofIsTruncationError) {
  EstablishConnection();
  const std::string next_frame = BuildFrame("next");

  SendThenFinish(next_frame.substr(0, 7));

  ASSERT_TRUE(listener_->WaitForError());
  EXPECT_EQ(listener_->error_code(), 0);
  EXPECT_EQ(listener_->error_message(), "truncated message header");
}

TEST_F(UsbClientTest, CompleteInvalidHeaderIsProtocolMismatchError) {
  EstablishConnection();
  std::string next_frame = BuildFrame("next");
  next_frame[0] = static_cast<char>(0x7f);

  SendThenFinish(next_frame);

  ASSERT_TRUE(listener_->WaitForError());
  EXPECT_EQ(
      listener_->error_message(),
      "ReadAndCheckMessageHeader error: don't match DebugRouter protocol");
}

TEST_F(UsbClientTest, PartialPayloadSizeEofIsTruncationError) {
  EstablishConnection();
  const std::string next_frame = BuildFrame("next");

  SendThenFinish(next_frame.substr(0, kFrameHeaderLen + 2));

  ASSERT_TRUE(listener_->WaitForError());
  EXPECT_EQ(listener_->error_code(), 0);
  EXPECT_EQ(listener_->error_message(), "truncated payload size");
}

TEST_F(UsbClientTest, PartialPayloadEofIsTruncationError) {
  EstablishConnection();
  const std::string next_frame = BuildFrame("next");

  SendThenFinish(next_frame.substr(0, kFrameHeaderLen + kPayloadSizeLen + 2));

  ASSERT_TRUE(listener_->WaitForError());
  EXPECT_EQ(listener_->error_code(), 0);
  EXPECT_EQ(listener_->error_message(), "truncated payload");
}

TEST_F(UsbClientTest, PartialFirstPayloadDoesNotOpenConnection) {
  const std::string frame = BuildFrame("first");

  SendThenFinish(frame.substr(0, kFrameHeaderLen + kPayloadSizeLen + 2));

  ASSERT_TRUE(listener_->WaitForError());
  EXPECT_EQ(listener_->error_count(), 1);
  EXPECT_EQ(listener_->open_count(), 0);
  EXPECT_EQ(listener_->error_message(), "truncated payload");
}

TEST_F(UsbClientTest, PayloadSizeMismatchIsProtocolError) {
  std::string frame = BuildFrame("next");
  char encoded[4];
  util::IntToCharArray(5, encoded);
  memcpy(frame.data() + kFrameHeaderLen, encoded, sizeof(encoded));

  SendThenFinish(frame.substr(0, kFrameHeaderLen + kPayloadSizeLen));

  ASSERT_TRUE(listener_->WaitForError());
  EXPECT_EQ(listener_->error_count(), 1);
  EXPECT_EQ(listener_->open_count(), 0);
  EXPECT_EQ(listener_->error_code(), 0);
  EXPECT_EQ(listener_->error_message(), "message payload size mismatch");
}

TEST_F(UsbClientTest, LocalStopDoesNotReportRemoteReadError) {
  EstablishConnection();

  client_->Stop();

  EXPECT_EQ(listener_->error_count(), 0);
}

TEST(UsbClientReadTest, CapturesSocketErrorAtRecvFailure) {
  UsbClient client(kInvalidSocket);

  const auto [is_error, error_code] = UsbClientTestPeer::ReadOneByte(client);
  errno = EAGAIN;

  EXPECT_TRUE(is_error);
  EXPECT_EQ(error_code, EBADF);
}

}  // namespace
}  // namespace socket_server
}  // namespace debugrouter

#endif  // _WIN32
