// Copyright 2023 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

#ifndef DEBUGROUTER_NATIVE_SOCKET_SOCKET_SERVER_TYPE_H
#define DEBUGROUTER_NATIVE_SOCKET_SOCKET_SERVER_TYPE_H

#include <cstdint>
#ifdef _WIN32
#include "WinSock2.h"
#endif

namespace debugrouter {
namespace socket_server {

#ifdef _WIN32
typedef SOCKET SocketType;
constexpr SocketType kInvalidSocket = INVALID_SOCKET;
#else
typedef int SocketType;
constexpr SocketType kInvalidSocket = -1;
#endif

// list of connect status
enum USBConnectStatus {
  DISCONNECTED,
  CONNECTING,
  CONNECTED,
};

typedef uint16_t PORT_TYPE;

// SocketServer listen start with kStartPort
constexpr int32_t kInvalidPort = -1;
constexpr PORT_TYPE kStartPort = 8901;
constexpr int32_t kTryPortCount = 20;

// max pending connections
constexpr int32_t kConnectionQueueMaxLength = 512;

// SocketServer Connection status
enum ConnectionStatus { kError = -2, kDisconnected = -1, kConnected = 0 };

constexpr int kFrameHeaderLen = 16;
constexpr int kPayloadSizeLen = 4;

// There will be three threads: reader, writer and message dispatcher.
constexpr int kThreadCount = 3;

// message size limit
constexpr uint64_t kMaxMessageLength = ((uint64_t)1) << 32;

// message_type
constexpr int32_t kPTFrameTypeTextMessage = 101;

// flag
constexpr int32_t kFrameDefaultTag = 0;

// protocol version
constexpr int32_t kFrameProtocolVersion = 1;

}  // namespace socket_server
}  // namespace debugrouter

#endif  // DEBUGROUTER_NATIVE_SOCKET_SOCKET_SERVER_TYPE_H
