// Copyright 2023 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

#include <chrono>
#include <cstdlib>
#include <cstring>
#include <set>
#include <string>
#include <thread>
#include <vector>

#include "debug_router/native/base/socket_guard.h"
#include "debug_router/native/core/debug_router_core.h"
#include "debug_router/native/core/util.h"
#include "debug_router/native/socket/socket_server_type.h"
#include "gtest/gtest.h"

#ifndef _WIN32
#include <arpa/inet.h>
#include <netinet/in.h>
#include <sys/socket.h>
#include <unistd.h>

#include <cerrno>
#endif

namespace {

void SetInterruptedSocketError() {
#if defined(_WIN32)
  WSASetLastError(WSAEINTR);
#else
  errno = EINTR;
#endif
}

void SetFatalSocketError() {
#if defined(_WIN32)
  WSASetLastError(WSAECONNRESET);
#else
  errno = EIO;
#endif
}

#ifndef _WIN32
std::set<int32_t> ScanOccupiedDebugRouterPorts() {
  std::set<int32_t> ports;
  const int32_t end_port = debugrouter::socket_server::kStartPort +
                           debugrouter::socket_server::kTryPortCount;
  for (int32_t port = debugrouter::socket_server::kStartPort; port < end_port;
       ++port) {
    const int socket_fd = socket(AF_INET, SOCK_STREAM, 0);
    if (socket_fd < 0) {
      continue;
    }
    int on = 1;
    setsockopt(socket_fd, SOL_SOCKET, SO_REUSEADDR, &on, sizeof(on));

    sockaddr_in addr{};
    addr.sin_family = AF_INET;
    addr.sin_port = htons(static_cast<uint16_t>(port));
    addr.sin_addr.s_addr = htonl(INADDR_ANY);

    errno = 0;
    if (bind(socket_fd, reinterpret_cast<sockaddr*>(&addr), sizeof(addr)) !=
            0 &&
        errno == EADDRINUSE) {
      ports.insert(port);
    }
    close(socket_fd);
  }
  return ports;
}

#if defined(DEBUGROUTER_ENABLE_IOS_USB_START_PORT)
bool CanBindPort(int32_t port) {
  const int socket_fd = socket(AF_INET, SOCK_STREAM, 0);
  if (socket_fd < 0) {
    return false;
  }
  int on = 1;
  setsockopt(socket_fd, SOL_SOCKET, SO_REUSEADDR, &on, sizeof(on));

  sockaddr_in addr{};
  addr.sin_family = AF_INET;
  addr.sin_port = htons(static_cast<uint16_t>(port));
  addr.sin_addr.s_addr = htonl(INADDR_ANY);

  const bool can_bind =
      bind(socket_fd, reinterpret_cast<sockaddr*>(&addr), sizeof(addr)) == 0;
  close(socket_fd);
  return can_bind;
}

int32_t FindAvailablePort(int32_t start_port, int32_t end_port) {
  for (int32_t port = start_port; port <= end_port; ++port) {
    if (CanBindPort(port)) {
      return port;
    }
  }
  return debugrouter::socket_server::kInvalidPort;
}
#endif

template <class Predicate>
bool WaitUntil(Predicate predicate, int timeout_ms = 2000) {
  const auto deadline =
      std::chrono::steady_clock::now() + std::chrono::milliseconds(timeout_ms);
  while (std::chrono::steady_clock::now() < deadline) {
    if (predicate()) {
      return true;
    }
    std::this_thread::sleep_for(std::chrono::milliseconds(20));
  }
  return predicate();
}

std::string BuildUsbFrame(const std::string& payload) {
  std::string frame(debugrouter::socket_server::kFrameHeaderLen +
                        debugrouter::socket_server::kPayloadSizeLen +
                        payload.size(),
                    '\0');
  debugrouter::util::IntToCharArray(
      debugrouter::socket_server::kFrameProtocolVersion, frame.data());
  debugrouter::util::IntToCharArray(
      debugrouter::socket_server::kPTFrameTypeTextMessage, frame.data() + 4);
  debugrouter::util::IntToCharArray(
      debugrouter::socket_server::kFrameDefaultTag, frame.data() + 8);
  debugrouter::util::IntToCharArray(
      static_cast<uint32_t>(debugrouter::socket_server::kPayloadSizeLen +
                            payload.size()),
      frame.data() + 12);
  debugrouter::util::IntToCharArray(static_cast<uint32_t>(payload.size()),
                                    frame.data() + 16);
  if (!payload.empty()) {
    memcpy(frame.data() + debugrouter::socket_server::kFrameHeaderLen +
               debugrouter::socket_server::kPayloadSizeLen,
           payload.data(), payload.size());
  }
  return frame;
}

int ConnectToLocalUsbPort(int32_t port) {
  const int client_socket = socket(AF_INET, SOCK_STREAM, 0);
  if (client_socket < 0) {
    return -1;
  }

  sockaddr_in addr{};
  addr.sin_family = AF_INET;
  addr.sin_port = htons(static_cast<uint16_t>(port));
  addr.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
  if (connect(client_socket, reinterpret_cast<sockaddr*>(&addr),
              sizeof(addr)) != 0) {
    close(client_socket);
    return -1;
  }

  return client_socket;
}
#endif

}  // namespace

TEST(SocketUtilTestSuite, TestCharToUInt32) {
  EXPECT_EQ(debugrouter::util::CharToUInt32(0xF0), (uint32_t)240);
  EXPECT_EQ(debugrouter::util::CharToUInt32(1), (uint32_t)1);
}

TEST(SocketUtilTestSuite, TestIntToCharArray1) {
  char array[4];
  uint32_t result[4] = {0, 0, 3, 232};
  debugrouter::util::IntToCharArray(1000, array);
  for (int i = 0; i < 4; i++) {
    EXPECT_EQ(debugrouter::util::CharToUInt32(array[i]), result[i]);
  }
}

TEST(SocketUtilTestSuite, TestIntToCharArray2) {
  char array[4];
  uint32_t result[4] = {0, 0, 0, 255};
  debugrouter::util::IntToCharArray(255, array);
  for (int i = 0; i < 4; i++) {
    EXPECT_EQ(debugrouter::util::CharToUInt32(array[i]), result[i]);
  }
}

TEST(SocketUtilTestSuite, TestIntToCharArray3) {
  char array[4];
  uint32_t result[4] = {0, 0, 1, 0};
  debugrouter::util::IntToCharArray(256, array);
  for (int i = 0; i < 4; i++) {
    EXPECT_EQ(debugrouter::util::CharToUInt32(array[i]), result[i]);
  }
}

TEST(SocketUtilTestSuite, TestDecodePayloadSize) {
  char array[4] = {0, 0, 1, 0};
  uint32_t result = 256;
  EXPECT_EQ(debugrouter::util::DecodePayloadSize(array, 4), result);
}

TEST(SocketUtilTestSuite, TestDecodePayloadSize2) {
  srand(time(NULL));
  uint32_t rand_number = rand() % ((1UL << 32) - 1);
  char array[4];
  debugrouter::util::IntToCharArray(rand_number, array);
  uint32_t result = debugrouter::util::DecodePayloadSize(array, 4);
  EXPECT_EQ(result, rand_number);
}

TEST(SocketUtilTestSuite, TestCheckHeader) {
  char header[16] = {0, 0, 0, 1, 0, 0, 0, 101, 0, 0, 0, 0, 0, 0, 0, 31};

  EXPECT_EQ(true, debugrouter::util::CheckHeaderThreeBytes(header));
  EXPECT_EQ(true, debugrouter::util::CheckHeaderFourthByte(header, 27));
}

TEST(SocketUtilTestSuite, SendAllWithCompletesPositivePartialWrites) {
  const std::string message = "complete this frame";
  std::string sent;
  std::vector<size_t> remaining_lengths;
  size_t call_count = 0;

  const bool result = debugrouter::base::internal::SendAllWith(
      message.data(), message.size(),
      [&](const void* buffer, size_t length) -> SocketSendResult {
        EXPECT_EQ(static_cast<const char*>(buffer),
                  message.data() + sent.size());
        remaining_lengths.push_back(length);
        const size_t written = call_count++ == 0 ? 3
                               : call_count == 2 ? 5
                                                 : length;
        sent.append(static_cast<const char*>(buffer), written);
        return static_cast<SocketSendResult>(written);
      });

  EXPECT_TRUE(result);
  EXPECT_EQ(sent, message);
  EXPECT_EQ(remaining_lengths,
            std::vector<size_t>(
                {message.size(), message.size() - 3, message.size() - 8}));
}

TEST(SocketUtilTestSuite, SendAllWithRetriesInterruptedWrite) {
  const std::string message = "message";
  size_t call_count = 0;

  const bool result = debugrouter::base::internal::SendAllWith(
      message.data(), message.size(),
      [&](const void*, size_t length) -> SocketSendResult {
        if (call_count++ == 0) {
          SetInterruptedSocketError();
          return -1;
        }
        return static_cast<SocketSendResult>(length);
      });

  EXPECT_TRUE(result);
  EXPECT_EQ(call_count, 2u);
}

TEST(SocketUtilTestSuite, SendAllWithStopsOnZeroWrite) {
  size_t call_count = 0;
  const bool result = debugrouter::base::internal::SendAllWith(
      "message", 7, [&](const void*, size_t) -> SocketSendResult {
        ++call_count;
        return 0;
      });

  EXPECT_FALSE(result);
  EXPECT_EQ(call_count, 1u);
}

TEST(SocketUtilTestSuite, SendAllWithStopsOnFatalWriteError) {
  size_t call_count = 0;
  const bool result = debugrouter::base::internal::SendAllWith(
      "message", 7, [&](const void*, size_t) -> SocketSendResult {
        ++call_count;
        SetFatalSocketError();
        return -1;
      });

  EXPECT_FALSE(result);
  EXPECT_EQ(call_count, 1u);
}

#ifndef _WIN32
#if defined(DEBUGROUTER_ENABLE_IOS_USB_START_PORT)
TEST(SocketUtilTestSuite, SettingUsbStartPortRestartsRunningDebugChannel) {
  auto& core = debugrouter::core::DebugRouterCore::GetInstance();
  core.DisableDebugChannel();

  const int32_t first_port = FindAvailablePort(19101, 19200);
  ASSERT_NE(first_port, debugrouter::socket_server::kInvalidPort);
  ASSERT_TRUE(core.SetUSBStartPort(first_port));
  core.EnableDebugChannel();

  int first_client_socket = -1;
  ASSERT_TRUE(WaitUntil([&]() {
    if (core.GetUSBPort() != first_port) {
      return false;
    }
    first_client_socket = ConnectToLocalUsbPort(first_port);
    return first_client_socket >= 0;
  }));
  close(first_client_socket);

  const int32_t second_port = FindAvailablePort(first_port + 1, 19250);
  ASSERT_NE(second_port, debugrouter::socket_server::kInvalidPort);
  ASSERT_TRUE(core.SetUSBStartPort(second_port));

  int second_client_socket = -1;
  ASSERT_TRUE(WaitUntil([&]() {
    if (core.GetUSBPort() != second_port) {
      return false;
    }
    second_client_socket = ConnectToLocalUsbPort(second_port);
    return second_client_socket >= 0;
  }));
  EXPECT_EQ(core.GetUSBPort(), second_port);

  close(second_client_socket);
  core.DisableDebugChannel();
  ASSERT_TRUE(core.SetUSBStartPort(debugrouter::socket_server::kStartPort));
}
#endif

TEST(SocketUtilTestSuite, SendNoSigPipeFailsWithoutTerminatingOnClosedPeer) {
  int sockets[2] = {-1, -1};
  ASSERT_EQ(socketpair(AF_UNIX, SOCK_STREAM, 0, sockets), 0);

  debugrouter::base::SocketGuard writer(sockets[0]);
  ASSERT_EQ(close(sockets[1]), 0);

  const char message[] = "x";
  errno = 0;
  auto result =
      debugrouter::base::SendNoSigPipe(writer.Get(), message, sizeof(message));

  EXPECT_EQ(result, -1);
  EXPECT_EQ(errno, EPIPE);
}

TEST(SocketUtilTestSuite,
     EnableSingleSessionDoesNotStartUsbServerUntilDebugChannelEnabled) {
  const std::set<int32_t> ports_before = ScanOccupiedDebugRouterPorts();

  auto& core = debugrouter::core::DebugRouterCore::GetInstance();
  core.DisableDebugChannel();
  core.EnableSingleSession(123);

  EXPECT_TRUE(core.isActiveSession(123));
  EXPECT_TRUE(WaitUntil([&ports_before]() {
    return ScanOccupiedDebugRouterPorts() == ports_before;
  }));

  core.EnableDebugChannel();

  std::set<int32_t> ports_after_enable;
  ASSERT_TRUE(WaitUntil([&]() {
    ports_after_enable = ScanOccupiedDebugRouterPorts();
    return ports_after_enable.size() == ports_before.size() + 1;
  }));

  core.DisableDebugChannel();

  EXPECT_TRUE(WaitUntil([&ports_before]() {
    return ScanOccupiedDebugRouterPorts() == ports_before;
  }));
}

TEST(
    SocketUtilTestSuite,
    DisableDebugChannelRestoresDisconnectedStateForSingleSessionUsbConnection) {
  auto& core = debugrouter::core::DebugRouterCore::GetInstance();
  core.DisableDebugChannel();

  core.EnableSingleSession(123);
  core.EnableDebugChannel();
  int client_socket = -1;
  ASSERT_TRUE(WaitUntil([&]() {
    const int32_t usb_port = core.GetUSBPort();
    if (usb_port == debugrouter::socket_server::kInvalidPort) {
      return false;
    }
    client_socket = ConnectToLocalUsbPort(usb_port);
    return client_socket >= 0;
  }));

  const std::string frame = BuildUsbFrame("");
  ASSERT_EQ(send(client_socket, frame.data(), frame.size(), 0),
            static_cast<ssize_t>(frame.size()));
  ASSERT_TRUE(WaitUntil([&]() {
    return core.GetConnectionState() == debugrouter::core::CONNECTED;
  }));

  core.DisableDebugChannel();
  EXPECT_EQ(core.GetConnectionState(), debugrouter::core::DISCONNECTED);
  EXPECT_TRUE(WaitUntil([&]() {
    return core.GetConnectionState() == debugrouter::core::DISCONNECTED;
  }));

  close(client_socket);
}
#endif
