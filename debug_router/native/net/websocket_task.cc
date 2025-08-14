// Copyright 2025 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

#include "debug_router/native/net/websocket_task.h"

#include "debug_router/native/core/util.h"
#include "debug_router/native/log/logging.h"

#if defined(_WIN32)
#include <winsock2.h>
#include <ws2tcpip.h>
#else
#include <errno.h>
#include <netdb.h>
#include <sys/socket.h>
#include <sys/types.h>
#include <unistd.h>

#define SOCKET int
#endif

namespace debugrouter {
namespace net {

int GetErrorMessage() {
#ifdef _WIN32
  return WSAGetLastError();
#else
  return errno;
#endif
}

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

WebSocketTask::WebSocketTask(
    std::shared_ptr<core::MessageTransceiver> transceiver,
    const std::string &url)
    : transceiver_(transceiver),
      url_(url),
      socket_guard_(std::make_unique<base::SocketGuard>(kInvalidSocket)) {}

WebSocketTask::~WebSocketTask() { shutdown(); }

void WebSocketTask::SendInternal(const std::string &data) {
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

  if (!socket_guard_) {
    onFailure("Socket_guard_ is nullptr.", kNullSocketGuard);
    return;
  }
  LOGI("[TX] SendInternal: " << buf);
  if (send(socket_guard_->Get(), (char *)prefix, prefix_len, 0) == -1) {
    LOGI("send prefix_len error.");
    onFailure("Send prefix_len error.", GetErrorMessage());
    return;
  }
  if (send(socket_guard_->Get(), buf, payloadLen, 0) == -1) {
    LOGI("send buf error.");
    onFailure("Send buf error.", GetErrorMessage());
    return;
  }
  LOGI("send: prefix_len and buf success.");
}

void WebSocketTask::Start() {
  submit([this]() { StartInternal(); });
}

void WebSocketTask::StartInternal() {
  if (!do_connect()) {
    LOGI("Websocket connect failed.");
    return;
  }

  onOpen();

  std::string msg;
  while (do_read(msg)) {
    LOGI("[RX]:" << msg);
    onMessage(msg);
  }
}

void WebSocketTask::Stop() {
  LOGI("WebSocketTask::Stop");
  socket_guard_->Reset();
  shutdown();
}

bool WebSocketTask::do_connect() {
  LOGI("WebSocketTask::do_connect");
  url_ = util::decodeURIComponent(url_);
  const char *purl = url_.c_str();
  if (memcmp(purl, "wss://", 6) == 0) {
    purl += 6;
  } else if (memcmp(purl, "ws://", 5) == 0) {
    purl += 5;
  } else {
    LOGE("Parse url error, url: " << purl);
    onFailure("Websocket Task: Parse url error.", kParseUrlErrorCode);
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
    onFailure("Websocket Task: Parse url error.", kParseUrlErrorCode);
    return false;
  }

  struct addrinfo ai, *servinfo;
  memset(&ai, 0, sizeof ai);
  ai.ai_family = AF_INET;  // IPV4
  ai.ai_socktype = SOCK_STREAM;
  char str_port[16];
  snprintf(str_port, sizeof(str_port), "%d", port);
  /*
  Reason why getaddrinfo fails:
  - DNS resolution issues:
    getaddrinfo fails if the hostname cannot be resolved to an IP address via
  DNS. For example, an incorrect hostname was entered, or the DNS server is not
  configured correctly.
  - Network connection issues:
    In some cases, an unstable or unavailable network connection may prevent the
  DNS server from being accessed, causing resolution to fail.
  - Configuration errors:
    The hostname or port number entered is in the wrong format, or an
  unsupported address family is used (for example, IPv6 is specified but the
  system does not support it).
  - Network isolation:
    The network environment is isolated, which limits DNS query requests and can
  also cause getaddrinfo to fail to work properly.
  */
  int ret = getaddrinfo(host, str_port, &ai, &servinfo);
  if (ret != 0) {
#ifdef _WIN32
    LOGE("getaddrinfo Error: " << gai_strerror(ret));
    onFailure("Websocket Task: getaddrinfo Error.", ret);
#else
    // Other system error; errno is set to indicate the error.
    if (ret == EAI_SYSTEM) {
      LOGE("getaddrinfo Error: " << strerror(GetErrorMessage()));
      onFailure("Websocket Task: getaddrinfo Error.", GetErrorMessage());
    } else {
      LOGE("getaddrinfo Error: " << gai_strerror(ret));
      onFailure("Websocket Task: getaddrinfo Error.", ret);
    }
#endif
    return false;
  }

  bool is_connect_success = false;
  for (auto p = servinfo; p != NULL; p = p->ai_next) {
    auto sockfd = socket(p->ai_family, p->ai_socktype, p->ai_protocol);
    if (sockfd == -1) {
      continue;
    }
    // Upon successful completion, connect() shall return 0; otherwise, -1 shall
    // be returned and errno set to indicate the error.
    if (connect(sockfd, p->ai_addr, p->ai_addrlen) != -1) {
      socket_guard_ = std::make_unique<base::SocketGuard>(sockfd);
      is_connect_success = true;
      LOGI("Connect socket success. sockfd: " << sockfd);
      break;
    } else {
      LOGE("connect Error: " << GetErrorMessage());
    }
    CLOSESOCKET(sockfd);
  }
  /*
  Reason why connect fails:
  - Target host unreachable:
    The target host may not be powered on or may be unreachable on the network,
  for example, it may not be in the same subnet, or the network device (such as
  a router) may be misconfigured.
  - Target port not listening:
    There is no corresponding service listening on the specified port on the
  target host, and the connection attempt will be rejected.
  - Connection queue full:
    The connection queue of the target host is full and cannot accept new
  connection requests.
  - Firewall or network device restrictions:
    The firewall or other network devices may block the connection request,
  causing the connect to fail.
  - Operating system restrictions:
    The operating system may have certain restrictions on the number of
  connections or resource usage. When these restrictions are reached, new
  connection requests will fail.

  Error code:
  You can check errmsg by
  https://pubs.opengroup.org/onlinepubs/7908799/xns/syssocket.h.html
  */
  if (!is_connect_success) {
    onFailure("Websocket Task: socket connect failed.", GetErrorMessage());
  }

  if (socket_guard_ == nullptr) {
    LOGE("Connect " << url_.c_str() << "Error: socket_guard_ is nullptr.");
    return false;
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
  if (send(socket_guard_->Get(), buf, strlen(buf), 0) == -1) {
    LOGE("send http upgrade error: " << GetErrorMessage());
    onFailure("Websocket Task: socket send failed.", GetErrorMessage());
    return false;
  }

  /*
  Reason why connect fails:
  - Connection interruption:
    When reading data, the connection may have been closed by the other party,
  or the network may be interrupted, making it impossible to continue reading
  data.
  - Timeout:
    If not enough data is received within the specified time, readline may time
  out and return an error.
  - Data format error:
    If the data format sent by the other party does not meet the expectations of
  readline, it may cause reading failure.
  - Buffer overflow:
    If the amount of data read exceeds the size of the buffer, it may cause data
  loss or reading errors.
  */
  int status;
  if (readline(socket_guard_->Get(), buf, sizeof(buf)) < 10 ||
      sscanf(buf, "HTTP/1.1 %d Switching Protocols\r\n", &status) != 1 ||
      status != 101) {
    LOGE("Connect Error: " << url_.c_str());
    onFailure("Websocket Task: do_connect Switching Protocol failed.",
              GetErrorMessage());
    return false;
  }

  while (readline(socket_guard_->Get(), buf, sizeof(buf)) > 0 &&
         buf[0] != '\r') {
    size_t len = strlen(buf);
    buf[len - 2] = '\0';
    LOGI(buf);
  }
  return true;
}

bool WebSocketTask::do_read(std::string &msg) {
  struct {
    uint8_t flag_opcode;
    uint8_t mask_payload_len;
  } head;

  if (!socket_guard_) {
    onFailure("WebSocket do_read: socket_guard_ is nullptr.", kNullSocketGuard);
    return false;
  }

  if (recv(socket_guard_->Get(), (char *)&head, sizeof(head), 0) !=
      sizeof(head)) {
    LOGE("failed to read websocket message");
    onFailure(
        "Failed to read WebSocket message header, incomplete read. recv error.",
        GetErrorMessage());
    return false;
  }
  if ((head.flag_opcode & 0x80) == 0) {  // FIN
    LOGE("read_message not final fragment");
    onFailure("Received non-final WebSocket message fragment, not supported.",
              kUnexpectedOpcode);
    return false;
  }
  const uint8_t flags = head.flag_opcode >> 4;
  if ((head.mask_payload_len & 0x80) != 0) {  // masked payload
    LOGE("read_message masked");
    onFailure(
        "Received unexpected masked WebSocket message payload from server.",
        kUnexpectedMaskPayloadLen);
    return false;
  }
  size_t payloadLen = head.mask_payload_len & 0x7f;
  bool deflated = (flags & 4 /*FLAG_RSV1*/) != 0;
  if (deflated) {
    LOGE("deflated message unimplemented");
    onFailure("Deflated message unimplemented.", kDeflatedMessageUnimplemented);
    return false;
  }

  if (payloadLen == 126) {
    uint8_t len[2];
    recv(socket_guard_->Get(), (char *)&len, sizeof(len), 0);
    payloadLen = (len[0] << 8) | len[1];
  } else if (payloadLen == 127) {
    uint8_t len[8];
    recv(socket_guard_->Get(), (char *)&len, sizeof(len), 0);
    payloadLen = (len[4] << 24) | (len[5] << 16) | (len[6] << 8) | len[7];
  }

  msg.resize(payloadLen);

  if (recv(socket_guard_->Get(), const_cast<char *>(msg.data()), payloadLen,
           0) != payloadLen) {
    LOGE("failed to read websocket message");
    onFailure("Failed to read websocket message, recv failed.",
              GetErrorMessage());
    return false;
  }
  LOGI("WebSocketTask::do_read websocket message success.");
  return true;
}

void WebSocketTask::onOpen() {
  LOGI("WebSocketTask::onOpen");
  auto transceiver = transceiver_.lock();
  if (transceiver) {
    transceiver->delegate()->OnOpen(transceiver);
  }
}

void WebSocketTask::onFailure(const std::string &error_message,
                              int error_code) {
  LOGI("WebSocketTask::onFailure with error_code.");
  auto transceiver = transceiver_.lock();
  if (transceiver) {
    transceiver->delegate()->OnFailure(transceiver, error_message, error_code);
  }
}

void WebSocketTask::onMessage(const std::string &msg) {
  LOGI("WebSocketTask::onMessage");
  auto transceiver = transceiver_.lock();
  if (transceiver) {
    transceiver->delegate()->OnMessage(msg, transceiver);
  }
}
}  // namespace net
}  // namespace debugrouter
