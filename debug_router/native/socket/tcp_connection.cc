// Copyright 2024 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

#include "debug_router/native/socket/tcp_connection.h"

#include <chrono>

#include "debug_router/native/core/debug_router_core.h"
#include "debug_router/native/core/session_filter_util.h"
#include "debug_router/native/core/util.h"
#include "debug_router/native/log/logging.h"
#include "debug_router/native/socket/tcp_server.h"

#ifdef _WIN32
#include <winsock2.h>
#else
#include <errno.h>
#include <sys/socket.h>
#include <sys/time.h>
#include <unistd.h>
#endif

namespace debugrouter {
namespace socket_server {

const char *kMessageQuit = "quit";

// SO_RCVTIMEO timeout for recv() in TcpConnection::Read()
// Chosen as a balance between:
//   - Low latency for Stop() to complete (max wait 0.5s)
//   - Low CPU overhead (not waking up too frequently)
const int kTcpConnectionRecvTimeoutMs = 500;

int GetErrorMessage() {
#ifdef _WIN32
  return WSAGetLastError();
#else
  return errno;
#endif
}

TcpConnection::TcpConnection(SocketType socket_fd) : socket_guard_(socket_fd) {
  // Set SO_RCVTIMEO to avoid permanent blocking
  SocketType sock = socket_guard_.Get();
  if (sock != kInvalidSocket) {
#ifdef _WIN32
    DWORD timeout = kTcpConnectionRecvTimeoutMs;
    if (setsockopt(sock, SOL_SOCKET, SO_RCVTIMEO, (char *)&timeout,
                   sizeof(timeout)) == SOCKET_ERROR) {
      LOGE("TcpConnection: Failed to set SO_RCVTIMEO: " << WSAGetLastError());
    }
#else
    struct timeval timeout;
    timeout.tv_sec = 0;
    timeout.tv_usec = kTcpConnectionRecvTimeoutMs * 1000;
    if (setsockopt(sock, SOL_SOCKET, SO_RCVTIMEO, &timeout, sizeof(timeout)) ==
        -1) {
      LOGE("TcpConnection: Failed to set SO_RCVTIMEO: " << errno);
    }
#endif
  }
}

void TcpConnection::BeginTransportShutdown() {
  stopping_.store(true, std::memory_order_relaxed);
  connect_status_.store(TcpConnectionStatus::DISCONNECTED,
                        std::memory_order_relaxed);
  incoming_message_queue_.put(std::string(kMessageQuit));
  outgoing_message_queue_.put(std::string(kMessageQuit));
  socket_guard_.ShutdownAndReset();
}

void TcpConnection::NotifyErrorOnce(int32_t code, const std::string &message) {
  bool expected = false;
  if (!failure_reported_.compare_exchange_strong(expected, true,
                                                 std::memory_order_acq_rel,
                                                 std::memory_order_acquire)) {
    return;
  }
  if (listener_) {
    listener_->OnError(shared_from_this(), code, message);
  }
}

void TcpConnection::NotifyCloseOnce(int32_t code, const std::string &reason) {
  bool expected = false;
  // First gate ensures only one path can attempt close delivery. The
  // subsequent is_connected_ exchange keeps the pre-open case silent, which is
  // required for Stop/Close-before-open races.
  if (!closed_reported_.compare_exchange_strong(expected, true,
                                                std::memory_order_acq_rel,
                                                std::memory_order_acquire)) {
    return;
  }
  if (!is_connected_.exchange(false, std::memory_order_relaxed)) {
    return;
  }
  if (listener_) {
    listener_->OnClose(shared_from_this(), code, reason);
  }
}

void TcpConnection::SetConnectStatus(TcpConnectionStatus status) {
  connect_status_.store(status, std::memory_order_relaxed);
}

void TcpConnection::Init() {
  work_thread_.init();
  read_thread_.init();
  write_thread_.init();
  dispatch_thread_.init();
}

void TcpConnection::StartUp(const std::shared_ptr<TcpConnectionListener> &listener) {
  work_thread_.submit([client_ptr = shared_from_this(), listener]() {
    client_ptr->StartInternal(listener);
  });
}

void TcpConnection::StartInternal(
    const std::shared_ptr<TcpConnectionListener> &listener) {
  stopping_.store(false, std::memory_order_relaxed);
  failure_reported_.store(false, std::memory_order_relaxed);
  closed_reported_.store(false, std::memory_order_relaxed);
  connect_status_.store(TcpConnectionStatus::CONNECTING,
                        std::memory_order_relaxed);
  LOGI("StartInternal, listener is:" << listener.get());
  listener_ = listener;
  StartReader();
  StartWriter();
}

/**
 *  The DebugRouter message structure is:
 *
 *  struct message {
 *   uint32_t version, // [0,4) protocol version, current version is
 * FRAME_PROTOCOL_VERSION
 *
 *   uint32_t type, // [4, 8) message_type, DebugRouter only use text message,
 * current type is PTFrameTypeTextMessage
 *
 *   uint32_t tag, // [8, 12) unused, the value remains unchanged at
 * FRAME_DEFAULT_TAG
 *
 *   uint32_t payloadSize, // [12, 16) payload's size
 *
 *   PayLoad payload
 *  }
 *
 *  struct PayLoad {
 *      uint32_t len, // payload len
 *      uint32_t[payloadSize-4] content // payload content
 *  }
 *
 *  At DebugRouter, we use term 'header' represent version, type and tag.
 *
 *  checkMessageHeader will check header's value.
 */

TcpConnection::ReadResult TcpConnection::Read(char *buffer, uint32_t read_size,
                                      int32_t *error_code) {
  if (error_code) {
    *error_code = 0;
  }
  int64_t start = 0;
  while (start < read_size) {
    int64_t read_data_len =
        recv(socket_guard_.Get(), buffer + start, read_size - start, 0);
    if (read_data_len == 0) {
      if (stopping_.load(std::memory_order_relaxed)) {
        LOGI("Read: peer closed while stopping, exit read loop");
        return ReadResult::kStopped;
      }
      LOGI("Read: peer closed connection (EOF)"
           << " read target count:" << (read_size - start));
      return ReadResult::kClosed;
    }
    if (read_data_len < 0) {
      // Check if it's a timeout error
#ifdef _WIN32
      int error = WSAGetLastError();
      if (error == WSAEWOULDBLOCK || error == WSAETIMEDOUT) {
        // Timeout, check if we're stopping
        if (stopping_.load(std::memory_order_relaxed)) {
          LOGI("Read: stopping after recv timeout, exit read loop");
          return ReadResult::kStopped;
        }
        // Continue to next iteration to check again
        continue;
      }
#else
      int error = errno;
      if (error == EAGAIN || error == EWOULDBLOCK || error == ETIMEDOUT) {
        // Timeout, check if we're stopping
        if (stopping_.load(std::memory_order_relaxed)) {
          LOGI("Read: stopping after recv timeout, exit read loop");
          return ReadResult::kStopped;
        }
        // Continue to next iteration to check again
        continue;
      }
#endif
      if (stopping_.load(std::memory_order_relaxed)) {
        LOGI("Read: stopping after socket error, exit read loop");
        return ReadResult::kStopped;
      }
      LOGE("Read: read_data_len <= 0 :"
           << "read target count:" << (read_size - start)
           << " read_data_len:" << read_data_len << " error:" << error);
      if (error_code) {
        *error_code = error;
      }
      return ReadResult::kError;
    }
    start = start + read_data_len;
  }
  if (start != read_size) {
    LOGE("Read: read data count > read_size");
    return ReadResult::kError;
  }
  return ReadResult::kOk;
}

void TcpConnection::ReadMessage() {
  LOGI("TcpConnection: ReadMessage:" << socket_guard_.Get());
  bool isFirst = true;
  int32_t close_code = 0;
  std::string close_reason = "ReadMessage finished";
  while (true) {
    // Check if we're stopping
    if (stopping_.load(std::memory_order_relaxed)) {
      LOGI("TcpConnection: ReadMessage: stopping, exit loop");
      close_reason = "ReadMessage stopped";
      break;
    }

    char header[kFrameHeaderLen];
    memset(header, 0, kFrameHeaderLen);
    LOGI("TcpConnection: start check message header.");
    int32_t error_code = 0;
    ReadResult header_result = Read(header, kFrameHeaderLen, &error_code);
    if (header_result == ReadResult::kStopped) {
      close_reason = "ReadMessage stopped";
      break;
    }
    if (header_result == ReadResult::kClosed) {
      LOGI("TcpConnection: peer closed connection before next frame.");
      BeginTransportShutdown();
      close_reason = "peer closed connection (EOF)";
      break;
    }
    if (header_result == ReadResult::kError) {
      LOGE("read header data error.");
      BeginTransportShutdown();
      close_code = error_code;
      close_reason = "ReadMessage finished after socket error";
      if (!isFirst) {
        NotifyErrorOnce(error_code, "ReadMessage header read socket error");
      }
      break;
    }
    if (!util::CheckHeaderThreeBytes(header)) {
      LOGW("TcpConnection: don't match DebugRouter protocol:");
      // need DebugRouterReport to report invailed client.
      for (int i = 0; i < kFrameHeaderLen; i++) {
        LOGE("header " << i << " : #" << util::CharToUInt32(header[i]) << "#");
      }
      BeginTransportShutdown();
      close_code = GetErrorMessage();
      close_reason = "ReadMessage finished after protocol mismatch";
      if (!isFirst) {
        NotifyErrorOnce(close_code,
                        "ReadAndCheckMessageHeader error: don't match "
                        "DebugRouter protocol");
      }
      break;
    }
    if (isFirst) {
      LOGI("TcpConnection: handle first frame.");
      if (listener_) {
        is_connected_.store(true, std::memory_order_relaxed);
        listener_->OnOpen(shared_from_this(), ConnectionStatus::kConnected,
                          "Init Success!");
      }
      isFirst = false;
    }
    char payload_size[kPayloadSizeLen];
    ReadResult payload_size_result =
        Read(payload_size, kPayloadSizeLen, &error_code);
    if (payload_size_result == ReadResult::kStopped) {
      close_reason = "ReadMessage stopped";
      break;
    }
    if (payload_size_result == ReadResult::kClosed) {
      LOGI("read payload size hit EOF");
      BeginTransportShutdown();
      close_reason = "peer closed connection (EOF)";
      break;
    }
    if (payload_size_result == ReadResult::kError) {
      LOGE("read payload size data error: " << error_code);
      BeginTransportShutdown();
      close_code = error_code;
      close_reason = "ReadMessage finished after payload-size read error";
      NotifyErrorOnce(error_code, "read payload size data error.");
      break;
    }

    uint32_t payload_size_int =
        util::DecodePayloadSize(payload_size, kPayloadSizeLen);

    if (!util::CheckHeaderFourthByte(header, payload_size_int)) {
      LOGE("CheckHeader failed: Drop This Frame!");
      for (int i = 0; i < kFrameHeaderLen; i++) {
        LOGE("header " << i << " : #" << util::CharToUInt32(header[i]) << "#");
      }
      continue;
    }
    std::unique_ptr<char[]> payload(new char[payload_size_int]);
    ReadResult payload_result =
        Read(payload.get(), payload_size_int, &error_code);
    if (payload_result == ReadResult::kStopped) {
      close_reason = "ReadMessage stopped";
      break;
    }
    if (payload_result == ReadResult::kClosed) {
      LOGI("read payload hit EOF");
      BeginTransportShutdown();
      close_reason = "peer closed connection (EOF)";
      break;
    }
    if (payload_result == ReadResult::kError) {
      LOGI("read payload data error: " << error_code);
      BeginTransportShutdown();
      close_code = error_code;
      close_reason = "ReadMessage finished after payload read error";
      NotifyErrorOnce(error_code, "read payload data error:");
      break;
    }

    std::string payload_str(payload.get(), payload_size_int);

    LOGI("[RX]:" << payload_str);
    if (core::internal::ShouldDropIncomingBySessionFilter(payload_str, "TCP")) {
      continue;
    }

    incoming_message_queue_.put(std::move(payload_str));
  }
  // end read loop.
  LOGI("TcpConnection: ReadMessage finished.");
  NotifyCloseOnce(close_code, close_reason);
  LOGI("TcpConnection: ReadMessage thread exit.");
  incoming_message_queue_.put(std::move(kMessageQuit));
  outgoing_message_queue_.put(std::move(kMessageQuit));
}

void TcpConnection::StartReader() {
  StartMessageDispatcher();
  read_thread_.submit(
      [client_ptr = shared_from_this()]() { client_ptr->ReadMessage(); });
}

void TcpConnection::MessageDispatcher() {
  while (true) {
    std::string message = "";
    message = incoming_message_queue_.take();

    if (message == kMessageQuit) {
      LOGI("TcpConnection: MessageDispatcherFunc receive MESSAGE_QUIT.");
      break;
    }

    if (message.length() > 0) {
      if (listener_) {
        listener_->OnMessage(shared_from_this(), message);
      }
    }
  }
}

void TcpConnection::StartMessageDispatcher() {
  dispatch_thread_.submit(
      [client_ptr = shared_from_this()]() { client_ptr->MessageDispatcher(); });
}

void TcpConnection::WrapHeader(const std::string &message, std::string &result) {
  const uint32_t total_size =
      static_cast<uint32_t>(kFrameHeaderLen + kPayloadSizeLen + message.size());
  result.resize(total_size);
  char *buffer = &result[0];
  char char_array[4];
  // write kFrameProtocolVersion
  util::IntToCharArray(kFrameProtocolVersion, char_array);
  memcpy(buffer, char_array, 4);

  // write kPTFrameTypeTextMessage
  util::IntToCharArray(kPTFrameTypeTextMessage, char_array);
  memcpy(buffer + 4, char_array, 4);

  // write kFrameDefaultTag
  util::IntToCharArray(kFrameDefaultTag, char_array);
  memcpy(buffer + 8, char_array, 4);

  // write len
  uint32_t len =
      static_cast<uint32_t>(kFrameHeaderLen + kPayloadSizeLen + message.size());
  util::IntToCharArray(len, char_array);
  memcpy(buffer + 12, char_array, 4);

  // write message.size()
  util::IntToCharArray(static_cast<uint32_t>(message.size()), char_array);
  memcpy(buffer + 16, char_array, 4);

  // write message
  memcpy(buffer + 20, message.c_str(), message.size());
}

void TcpConnection::WriteMessage() {
  LOGI("TcpConnection: WriteMessage:" << socket_guard_.Get());
  while (true) {
    std::string message;
    message = outgoing_message_queue_.take();

    if (message == kMessageQuit) {
      break;
    }

    if (message.length() > 0) {
      if (message.find("Page.screencastFrame") != std::string::npos) {
        LOGI("TcpConnection: [TX]: Page.screencastFrame Sent.");
      } else if (message.find("Lynx.screenshotCapture") != std::string::npos) {
        LOGI("TcpConnection: [TX]: Lynx.screenshotCapture Sent.");
      } else {
        LOGI("TcpConnection: [TX]:");
        LOGI(message);
      }
      std::string result_message;
      WrapHeader(message, result_message);
      if (base::SendNoSigPipe(socket_guard_.Get(), result_message.c_str(),
                              result_message.size()) == -1) {
        LOGE("send error: " << GetErrorMessage() << " message:" << message);
        BeginTransportShutdown();
        NotifyErrorOnce(GetErrorMessage(),
                        "TcpConnection::WriteMessage send data failed.");
        NotifyCloseOnce(GetErrorMessage(), "writer thread finished");
        break;
      }
    }
  }
  LOGI("TcpConnection: WriteMessage finished.");
  NotifyCloseOnce(GetErrorMessage(), "writer thread finished");
  LOGI("TcpConnection: WriteMessage thread exit.");
}

void TcpConnection::StartWriter() {
  write_thread_.submit(
      [client_ptr = shared_from_this()]() { client_ptr->WriteMessage(); });
}

void TcpConnection::DisconnectInternal() {
  // DisconnectInternal only handles transport/read-loop shutdown. Stop()
  // idempotence is guarded by stop_started_.
  BeginTransportShutdown();
}

bool TcpConnection::Send(const std::string &message) {
  LOGI("TcpConnection: Send.");
  if (stopping_.load(std::memory_order_relaxed) ||
      stop_started_.load(std::memory_order_relaxed)) {
    LOGI("TcpConnection: dropping send while stopping.");
    return false;
  }
  if (message.size() >
      (kMaxMessageLength - kFrameHeaderLen - kPayloadSizeLen)) {
    LOGE("current protocol only support 1UL << 32 bytes message");
    return false;
  }
  work_thread_.submit([client_ptr = shared_from_this(), message]() {
    client_ptr->SendInternal(message);
  });
  return true;
}

void TcpConnection::Stop() {
  bool expected = false;
  if (!stop_started_.compare_exchange_strong(expected, true,
                                             std::memory_order_acq_rel,
                                             std::memory_order_acquire)) {
    LOGI("TcpConnection: Stop already in progress or completed.");
    return;
  }

  auto start_time = std::chrono::steady_clock::now();
  DisconnectInternal();
  dispatch_thread_.shutdown();
  write_thread_.shutdown();
  read_thread_.shutdown();
  work_thread_.shutdown();

  incoming_message_queue_.clear();
  outgoing_message_queue_.clear();
  connect_status_.store(TcpConnectionStatus::DISCONNECTED,
                        std::memory_order_relaxed);

  auto end_time = std::chrono::steady_clock::now();
  auto duration = std::chrono::duration_cast<std::chrono::milliseconds>(
                      end_time - start_time)
                      .count();
  LOGI("TcpConnection: Stop finished in " << duration << "ms");
}

void TcpConnection::SendInternal(const std::string &message) {
  LOGI("TcpConnection: SendInternal.");
  if (stopping_.load(std::memory_order_relaxed) ||
      connect_status_.load(std::memory_order_relaxed) !=
          TcpConnectionStatus::CONNECTED) {
    LOGI("current tcp connection is not connected:" << message);
    return;
  }
  std::string non_const_message = message;
  outgoing_message_queue_.put(std::move(non_const_message));
}

TcpConnection::~TcpConnection() { Stop(); }

}  // namespace socket_server
}  // namespace debugrouter
