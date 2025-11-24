// Copyright 2025 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

#include "debug_router/native/socket/socket_server_type.h"

namespace debugrouter {
namespace socket_server {

#ifdef _WIN32
const SocketType kInvalidSocket = INVALID_SOCKET;
#else
const SocketType kInvalidSocket = -1;
#endif

const int32_t kInvalidPort = -1;
const PORT_TYPE kStartPort = 8901;
const int32_t kTryPortCount = 20;
const int32_t kConnectionQueueMaxLength = 512;

const int kFrameHeaderLen = 16;
const int kPayloadSizeLen = 4;
const int kThreadCount = 3;
const uint64_t kMaxMessageLength = ((uint64_t)1) << 32;
const int32_t kPTFrameTypeTextMessage = 101;
const int32_t kFrameDefaultTag = 0;
const int32_t kFrameProtocolVersion = 1;

}  // namespace socket_server
}  // namespace debugrouter
