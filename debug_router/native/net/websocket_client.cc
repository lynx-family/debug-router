// Copyright 2023 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

#include "debug_router/native/net/websocket_client.h"

#include <memory>
#include <sstream>

#include "debug_router/native/log/logging.h"

// http://tools.ietf.org/html/rfc6455#section-5.2  Base Framing Protocol
//
//  0                   1                   2                   3
//  0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1
// +-+-+-+-+-------+-+-------------+-------------------------------+
// |F|R|R|R| opcode|M| Payload len |    Extended payload length    |
// |I|S|S|S|  (4)  |A|     (7)     |             (16/64)           |
// |N|V|V|V|       |S|             |   (if payload len==126/127)   |
// | |1|2|3|       |K|             |                               |
// +-+-+-+-+-------+-+-------------+ - - - - - - - - - - - - - - - +
// |     Extended payload length continued, if payload len == 127  |
// + - - - - - - - - - - - - - - - +-------------------------------+
// |                               |Masking-key, if MASK set to 1  |
// +-------------------------------+-------------------------------+
// | Masking-key (continued)       |          Payload Data         |
// +-------------------------------- - - - - - - - - - - - - - - - +
// :                     Payload Data continued ...                :
// + - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - +
// |                     Payload Data continued ...                |
// +---------------------------------------------------------------+

namespace debugrouter {
namespace net {

WebSocketClient::WebSocketClient() {}

WebSocketClient::~WebSocketClient() { DisconnectInternal(); }

void WebSocketClient::Init() {}

bool WebSocketClient::Connect(const std::string &url) {
  LOGI("WebSocketClient::Connect");
  auto self = std::static_pointer_cast<WebSocketClient>(shared_from_this());
  work_thread_.submit([client_ptr = self, url]() {
    client_ptr->DisconnectInternal();
    client_ptr->ConnectInternal(url);
  });
  return true;
}

void WebSocketClient::ConnectInternal(const std::string &url) {
  LOGI("WebSocketClient::ConnectInternal: use " << url << " to connect.");
  current_task_ = std::make_unique<WebSocketTask>(shared_from_this(), url);
}

void WebSocketClient::Disconnect() {
  LOGI("WebSocketClient::Disconnect");
  auto self = std::static_pointer_cast<WebSocketClient>(shared_from_this());
  work_thread_.submit(
      [client_ptr = self]() { client_ptr->DisconnectInternal(); });
}

void WebSocketClient::DisconnectInternal() {
  LOGI("WebSocketClient::DisconnectInternal");
  if (current_task_) {
    current_task_->Stop();
    LOGI("WebSocketClient::DisconnectInternal: current_task_->Stop() success.");
  }
  current_task_.reset(nullptr);
}

core::ConnectionType WebSocketClient::GetType() {
  return core::ConnectionType::kWebSocket;
}

void WebSocketClient::Send(const std::string &data) {
  LOGI("WebSocketClient::Send.");
  work_thread_.submit([this, data]() {
    if (current_task_) {
      current_task_->SendInternal(data);
    }
  });
}

}  // namespace net
}  // namespace debugrouter
