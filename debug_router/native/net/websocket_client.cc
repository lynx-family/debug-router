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

static int readline(SOCKET sock, char *buf, size_t size) {
  char *out = buf;
  while (out - buf < size) {
    int res = static_cast<int>(recv(sock, out, 1, 0));
    if (res == 1) {
      if (*out++ == '\n') {
        break;
      }
    } else if (res == -1) {
      break;
    }
  }
  *out = '\0';
  return static_cast<int>(out - buf);
}

std::string decodeURIComponent(std::string url) {
  int flag = 0;
  int code = 0;
  std::stringstream result_url_;
  for (char c : url) {
    if ((flag == 0) && (c == '%')) {
      flag = 1;
      continue;
    } else if (flag == 1) {
      if (isxdigit(c)) {
        if (isdigit(c)) {
          code = c - '0';
        } else if (c >= 'A' && c <= 'F') {
          code = (0x0a + (c - 'A'));
        } else if (c >= 'a' && c <= 'f') {
          code = (0x0a + (c - 'a'));
        } else {
          return std::string();
        }
        flag = 2;
        continue;
      } else {
        return std::string();
      }
    } else if (flag == 2) {
      if (isxdigit(c)) {
        code <<= 4;
        if (isdigit(c)) {
          code |= (c - '0');
        } else if (c >= 'A' && c <= 'F') {
          code |= (0x0a + (c - 'A'));
        } else if (c >= 'a' && c <= 'f') {
          code |= (0x0a + (c - 'a'));
        } else {
          return std::string();
        }
        result_url_ << (char)(code & 0xff);
        code = 0;
        flag = 0;
        continue;
      } else {
        return std::string();
      }
    } else {
      result_url_ << c;
    }
  }
  return result_url_.str();
}

WebSocketClient::WebSocketClient() {}

WebSocketClient::~WebSocketClient() { Disconnect(); }

void WebSocketClient::Init() {}

bool WebSocketClient::Connect(const std::string &url) {
  Disconnect();

  mutex_.lock();
  url_ = url;
  thread_ = std::make_unique<std::thread>([this]() { run(); });
  mutex_.unlock();
  return true;
}

void WebSocketClient::Disconnect() {
  mutex_.lock();
  if (socket_) {
    CLOSESOCKET(socket_);
    socket_ = 0;
  }
  if (thread_) {
    if (thread_->joinable()) {
      thread_->join();
      LOGI("WebSocketClient thread exit successfully.");
    }
    thread_.reset();
  }
  mutex_.unlock();
}

core::ConnectionType WebSocketClient::GetType() {
  return core::ConnectionType::kWebSocket;
}

void WebSocketClient::Send(const std::string &data) {
  const char *buf = data.data();
  size_t payloadLen = data.size();
  uint8_t prefix[14];
  size_t prefix_len = 2;

  prefix[0] = 1 /*OP_TEXT*/ | 0x80 /*FIN*/;

  if (payloadLen > 65535) {
    prefix[1] = 127;
    *reinterpret_cast<uint32_t *>(prefix + 2) = 0;
    prefix[6] = payloadLen >> 24;
    prefix[7] = payloadLen >> 16;
    prefix[8] = payloadLen >> 8;
    prefix[9] = payloadLen;
    prefix_len += 8;
  } else if (payloadLen > 125) {
    prefix[1] = 126;
    prefix[2] = payloadLen >> 8;
    prefix[3] = payloadLen;
    prefix_len += 2;
  } else {
    prefix[1] = payloadLen;
  }

  // All frames sent from client to server have this bit set to 1.
  prefix[1] |= 0x80 /*MASK*/;
  *reinterpret_cast<uint32_t *>(prefix + prefix_len) = 0;
  prefix_len += 4;

  mutex_.lock();
  send(socket_, (char *)prefix, prefix_len, 0);
  send(socket_, buf, payloadLen, 0);
  mutex_.unlock();
}

void WebSocketClient::run() {
  auto self = std::static_pointer_cast<WebSocketClient>(shared_from_this());
  if (!do_connect()) {
    if (delegate()) {
      delegate()->OnFailure(self);
    }
    return;
  }

  if (delegate()) {
    delegate()->OnOpen(self);
  }

  std::string msg;
  while (do_read(msg)) {
    if (delegate()) {
      delegate()->OnMessage(msg, self);
    }
  }
}

bool WebSocketClient::do_connect() {
  url_ = decodeURIComponent(url_);
  const char *purl = url_.c_str();
  if (memcmp(purl, "wss://", 6) == 0) {
    purl += 6;
  } else if (memcmp(purl, "ws://", 5) == 0) {
    purl += 5;
  } else {
    LOGE("Parse url error, url: " << purl);
    return false;
  }

  char host[128] = {0};
  char path[256] = {0};
  int port = 80;
  if (sscanf(purl, "%[^:/]:%d/%s", host, &port, path) == 3) {
  } else if (sscanf(purl, "%[^:/]/%s", host, path) == 2) {
  } else if (sscanf(purl, "%[^:/]:%d", host, &port) == 2) {
  } else if (sscanf(purl, "%[^:/]", host) == 1) {
  } else {
    LOGE("Parse url error, url: " << purl);
    return false;
  }

  struct addrinfo ai, *servinfo;
  memset(&ai, 0, sizeof ai);
  ai.ai_family = AF_INET;  // IPV4
  ai.ai_socktype = SOCK_STREAM;
  char str_port[16];
  snprintf(str_port, sizeof(str_port), "%d", port);
  int ret = getaddrinfo(host, str_port, &ai, &servinfo);
  if (ret != 0) {
    LOGE("getaddrinfo Error");
    return false;
  }

  for (auto p = servinfo; p != NULL; p = p->ai_next) {
    auto sockfd = socket(p->ai_family, p->ai_socktype, p->ai_protocol);
    if (sockfd == -1) {
      continue;
    }
    if (connect(sockfd, p->ai_addr, p->ai_addrlen) != -1) {
      socket_ = sockfd;
      break;
    }
    CLOSESOCKET(sockfd);
  }
  freeaddrinfo(servinfo);

  char buf[512];
  snprintf(buf, sizeof(buf),
           "GET /%s HTTP/1.1\r\n"
           "Host: %s:%d\r\n"
           "Upgrade: websocket\r\n"
           "Connection: Upgrade\r\n"
           "Sec-WebSocket-Key: x3JJHMbDL1EzLkh9GBhXDw==\r\n"
           "Sec-WebSocket-Version: 13\r\n\r\n",
           path, host, port);
  send(socket_, buf, strlen(buf), 0);

  int status;
  if (readline(socket_, buf, sizeof(buf)) < 10 ||
      sscanf(buf, "HTTP/1.1 %d Switching Protocols\r\n", &status) != 1 ||
      status != 101) {
    LOGE("Connect Error: " << url_.c_str());
    return false;
  }

  while (readline(socket_, buf, sizeof(buf)) > 0 && buf[0] != '\r') {
    size_t len = strlen(buf);
    buf[len - 2] = '\0';
    LOGI(buf);
  }
  return true;
}

bool WebSocketClient::do_read(std::string &msg) {
  struct {
    uint8_t flag_opcode;
    uint8_t mask_payload_len;
  } head;

  if (recv(socket_, (char *)&head, sizeof(head), 0) != sizeof(head)) {
    LOGE("failed to read websocket message");
    return false;
  }
  if ((head.flag_opcode & 0x80) == 0) {  // FIN
    LOGE("read_message not final fragment");
    return false;
  }
  const uint8_t flags = head.flag_opcode >> 4;
  if ((head.mask_payload_len & 0x80) != 0) {  // masked payload
    LOGE("read_message masked");
    return false;
  }
  size_t payloadLen = head.mask_payload_len & 0x7f;
  bool deflated = (flags & 4 /*FLAG_RSV1*/) != 0;
  if (deflated) {
    LOGE("deflated message unimplemented");
    return false;
  }

  if (payloadLen == 126) {
    uint8_t len[2];
    recv(socket_, (char *)&len, sizeof(len), 0);
    payloadLen = (len[0] << 8) | len[1];
  } else if (payloadLen == 127) {
    uint8_t len[8];
    recv(socket_, (char *)&len, sizeof(len), 0);
    payloadLen = (len[4] << 24) | (len[5] << 16) | (len[6] << 8) | len[7];
  }

  msg.resize(payloadLen);

  if (recv(socket_, const_cast<char *>(msg.data()), payloadLen, 0) !=
      payloadLen) {
    LOGE("failed to read websocket message");
    return false;
  }
  return true;
}

}  // namespace net
}  // namespace debugrouter
