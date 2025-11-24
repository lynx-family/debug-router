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
extern const SocketType kInvalidSocket;
#else
typedef int SocketType;
extern const SocketType kInvalidSocket;
#endif

// list of connect status
enum USBConnectStatus {
  DISCONNECTED,
  CONNECTING,
  CONNECTED,
};

typedef uint16_t PORT_TYPE;

// SocketServer listen start with kStartPort
extern const int32_t kInvalidPort;
extern const PORT_TYPE kStartPort;
extern const int32_t kTryPortCount;

// max pending connections
extern const int32_t kConnectionQueueMaxLength;

// SocketServer Connection status
enum ConnectionStatus { kError = -2, kDisconnected = -1, kConnected = 0 };

extern const int kFrameHeaderLen;
extern const int kPayloadSizeLen;

// There will be three threads: reader, writer and message dispatcher.
extern const int kThreadCount;

// message size limit
extern const uint64_t kMaxMessageLength;

// message_type
extern const int32_t kPTFrameTypeTextMessage;

// flag
extern const int32_t kFrameDefaultTag;

// protocol version
extern const int32_t kFrameProtocolVersion;

}  // namespace socket_server
}  // namespace debugrouter

#endif  // DEBUGROUTER_NATIVE_SOCKET_SOCKET_SERVER_TYPE_H
