// Copyright 2024 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

#include "debug_router/native/socket/usb_client.h"

#include <chrono>

#include "debug_router/native/core/debug_router_core.h"
#include "debug_router/native/core/util.h"
#include "debug_router/native/log/logging.h"
#include "debug_router/native/socket/socket_server_api.h"
#include "third_party/jsoncpp/include/json/reader.h"
#include "third_party/jsoncpp/include/json/value.h"

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

// SO_RCVTIMEO timeout for recv() in UsbClient::Read()
// Chosen as a balance between:
//   - Low latency for Stop() to complete (max wait 0.5s)
//   - Low CPU overhead (not waking up too frequently)
const int kUsbClientRecvTimeoutMs = 500;

int GetErrorMessage() {
#ifdef _WIN32
  return WSAGetLastError();
#else
  return errno;
#endif
}

UsbClient::UsbClient(SocketType socket_fd) : socket_guard_(socket_fd) {
  // Set SO_RCVTIMEO to avoid permanent blocking
  SocketType sock = socket_guard_.Get();
  if (sock != kInvalidSocket) {
#ifdef _WIN32
    DWORD timeout = kUsbClientRecvTimeoutMs;
    if (setsockopt(sock, SOL_SOCKET, SO_RCVTIMEO, (char *)&timeout,
                   sizeof(timeout)) == SOCKET_ERROR) {
      LOGE("UsbClient: Failed to set SO_RCVTIMEO: " << WSAGetLastError());
    }
#else
    struct timeval timeout;
    timeout.tv_sec = 0;
    timeout.tv_usec = kUsbClientRecvTimeoutMs * 1000;
    if (setsockopt(sock, SOL_SOCKET, SO_RCVTIMEO, &timeout, sizeof(timeout)) ==
        -1) {
      LOGE("UsbClient: Failed to set SO_RCVTIMEO: " << errno);
    }
#endif
  }
}

void UsbClient::SetConnectStatus(USBConnectStatus status) {
  work_thread_.submit([client_ptr = shared_from_this(), status]() {
    client_ptr->connect_status_ = status;
  });
}

void UsbClient::Init() {
  work_thread_.init();
  read_thread_.init();
  write_thread_.init();
  dispatch_thread_.init();
}

void UsbClient::StartUp(const std::shared_ptr<UsbClientListener> &listener) {
  work_thread_.submit([client_ptr = shared_from_this(), listener]() {
    client_ptr->StartInternal(listener);
  });
}

void UsbClient::StartInternal(
    const std::shared_ptr<UsbClientListener> &listener) {
  stopping_.store(false, std::memory_order_relaxed);
  connect_status_ = USBConnectStatus::CONNECTING;
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

UsbClient::ReadOutcome UsbClient::Read(char *buffer, uint32_t read_size) {
  int64_t start = 0;
  while (start < read_size) {
    int64_t read_data_len =
        recv(socket_guard_.Get(), buffer + start, read_size - start, 0);
    if (read_data_len == 0) {
      if (stopping_.load(std::memory_order_relaxed)) {
        return {ReadResult::kStopped, 0};
      }
      return {start == 0 ? ReadResult::kEof : ReadResult::kTruncated, 0};
    }
    if (read_data_len < 0) {
      if (stopping_.load(std::memory_order_relaxed)) {
        return {ReadResult::kStopped, 0};
      }
      // Check if it's a timeout error
#ifdef _WIN32
      int error = WSAGetLastError();
      if (error == WSAEWOULDBLOCK || error == WSAETIMEDOUT) {
        // Continue to next iteration to check again
        continue;
      }
#else
      int error = errno;
      if (error == EAGAIN || error == EWOULDBLOCK || error == ETIMEDOUT) {
        // Continue to next iteration to check again
        continue;
      }
#endif
      LOGE("Read: read_data_len <= 0 :"
           << "read target count:" << (read_size - start)
           << " read_data_len:" << read_data_len << " error:" << error);
      return {ReadResult::kError, error};
    }
    start = start + read_data_len;
  }
  return {ReadResult::kSuccess, 0};
}

void UsbClient::ReadMessage() {
  LOGI("UsbClient: ReadMessage:" << socket_guard_.Get());
  bool isFirst = true;
  bool has_completed_frame = false;
  bool clean_eof = false;
  int32_t terminal_error_code = 0;
  auto report_read_failure = [&](const ReadOutcome &outcome,
                                 const char *truncated_message,
                                 const char *error_message) {
    terminal_error_code = outcome.error_code;
    if (outcome.result != ReadResult::kStopped && listener_) {
      listener_->OnError(shared_from_this(), outcome.error_code,
                         outcome.result == ReadResult::kError
                             ? error_message
                             : truncated_message);
    }
  };
  while (true) {
    // Check if we're stopping
    if (stopping_.load(std::memory_order_relaxed)) {
      break;
    }

    char header[kFrameHeaderLen];
    memset(header, 0, kFrameHeaderLen);
    ReadOutcome header_outcome = Read(header, kFrameHeaderLen);
    if (header_outcome.result != ReadResult::kSuccess) {
      if (header_outcome.result == ReadResult::kEof) {
        if (has_completed_frame) {
          clean_eof = true;
        } else {
          report_read_failure(header_outcome,
                              "peer closed before protocol frame", "");
        }
      } else {
        report_read_failure(header_outcome, "truncated message header",
                            "read message header data error");
      }
      break;
    }
    if (!util::CheckHeaderThreeBytes(header)) {
      LOGW("UsbClient: don't match DebugRouter protocol:");
      // need DebugRouterReport to report invailed client.
      for (int i = 0; i < kFrameHeaderLen; i++) {
        LOGE("header " << i << " : #" << util::CharToUInt32(header[i]) << "#");
      }
      if (listener_) {
        listener_->OnError(shared_from_this(), 0,
                           "ReadAndCheckMessageHeader error: don't match "
                           "DebugRouter protocol");
      }
      break;
    }
    char payload_size[kPayloadSizeLen];
    ReadOutcome payload_size_outcome = Read(payload_size, kPayloadSizeLen);
    if (payload_size_outcome.result != ReadResult::kSuccess) {
      if (payload_size_outcome.result != ReadResult::kStopped) {
        LOGE("read payload data error: " << payload_size_outcome.error_code);
      }
      report_read_failure(payload_size_outcome, "truncated payload size",
                          "read payload size data error.");
      break;
    }

    uint32_t payload_size_int =
        util::DecodePayloadSize(payload_size, kPayloadSizeLen);

    if (!util::CheckHeaderFourthByte(header, payload_size_int)) {
      LOGE("CheckHeader failed: payload size mismatch.");
      for (int i = 0; i < kFrameHeaderLen; i++) {
        LOGE("header " << i << " : #" << util::CharToUInt32(header[i]) << "#");
      }
      if (listener_) {
        listener_->OnError(shared_from_this(), 0,
                           "message payload size mismatch");
      }
      break;
    }
    std::unique_ptr<char[]> payload(new char[payload_size_int]);
    ReadOutcome payload_outcome = Read(payload.get(), payload_size_int);
    if (payload_outcome.result != ReadResult::kSuccess) {
      if (payload_outcome.result != ReadResult::kStopped) {
        LOGE("read payload data error: " << payload_outcome.error_code);
      }
      report_read_failure(payload_outcome, "truncated payload",
                          "read payload data error:");
      break;
    }
    has_completed_frame = true;
    if (isFirst) {
      LOGI("UsbClient: handle first frame.");
      if (listener_) {
        is_connected_.store(true, std::memory_order_relaxed);
        listener_->OnOpen(shared_from_this(), ConnectionStatus::kConnected,
                          "Init Success!");
      }
      isFirst = false;
    }

    std::string payload_str(payload.get(), payload_size_int);

    LOGI("[RX]:" << payload_str);

    // Check if all sessions are enabled
    bool enable_all_sessions =
        core::DebugRouterCore::GetInstance().isEnableAllSessions();

    // Only parse JSON if not all sessions are enabled
    if (!enable_all_sessions) {
      // get sessionID from payload_str
      int32_t session_id = -1;
      Json::Reader reader;
      Json::Value root;
      if (reader.parse(payload_str, root)) {
        if (root.isObject() && root["data"].isObject() &&
            root["data"]["data"].isObject()) {
          const Json::Value &session_id_value =
              root["data"]["data"]["session_id"];
          if (session_id_value.isNumeric()) {
            session_id = session_id_value.asInt();
          }
        }
      }
      if (session_id > 0 &&
          !core::DebugRouterCore::GetInstance().isActiveSession(session_id)) {
        LOGW("Drop message for inactive session_id: " << session_id);
        continue;
      }
    }

    incoming_message_queue_.put(std::move(payload_str));
  }
  if (listener_ && is_connected_.exchange(false, std::memory_order_relaxed)) {
    listener_->OnClose(
        shared_from_this(), terminal_error_code,
        clean_eof ? "peer closed connection" : "ReadMessage finished");
  }
  LOGI("UsbClient: ReadMessage thread exit.");
  incoming_message_queue_.put(std::move(kMessageQuit));
  outgoing_message_queue_.put(std::move(kMessageQuit));
}

void UsbClient::StartReader() {
  StartMessageDispatcher();
  read_thread_.submit(
      [client_ptr = shared_from_this()]() { client_ptr->ReadMessage(); });
}

void UsbClient::MessageDispatcher() {
  while (true) {
    std::string message = "";
    message = incoming_message_queue_.take();

    if (message == kMessageQuit) {
      LOGI("UsbClient: MessageDispatcherFunc receive MESSAGE_QUIT.");
      break;
    }

    if (message.length() > 0) {
      if (listener_) {
        listener_->OnMessage(shared_from_this(), message);
      }
    }
  }
}

void UsbClient::StartMessageDispatcher() {
  dispatch_thread_.submit(
      [client_ptr = shared_from_this()]() { client_ptr->MessageDispatcher(); });
}

void UsbClient::WrapHeader(const std::string &message, std::string &result) {
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

void UsbClient::WriteMessage() {
  LOGI("UsbClient: WriteMessage:" << socket_guard_.Get());
  while (true) {
    std::string message;
    message = outgoing_message_queue_.take();

    if (message == kMessageQuit) {
      break;
    }

    // Check if all sessions are enabled
    bool enable_all_sessions =
        core::DebugRouterCore::GetInstance().isEnableAllSessions();

    // Only parse JSON if not all sessions are enabled
    if (!enable_all_sessions) {
      int32_t session_id = -1;
      // get sessionID from message
      Json::Reader reader;
      Json::Value root;
      if (reader.parse(message, root)) {
        if (root.isObject() && root["data"].isObject() &&
            root["data"]["data"].isObject()) {
          const Json::Value &session_id_value =
              root["data"]["data"]["session_id"];
          if (session_id_value.isNumeric()) {
            session_id = session_id_value.asInt();
          }
        }
      }
      if (session_id > 0 &&
          !core::DebugRouterCore::GetInstance().isActiveSession(session_id)) {
        LOGW("Drop message for inactive session_id: " << session_id);
        continue;
      }
    }
    if (message.length() > 0) {
      if (message.find("Page.screencastFrame") != std::string::npos) {
        LOGI("UsbClient: [TX]: Page.screencastFrame Sent.");
      } else if (message.find("Lynx.screenshotCapture") != std::string::npos) {
        LOGI("UsbClient: [TX]: Lynx.screenshotCapture Sent.");
      } else {
        LOGI("UsbClient: [TX]:");
        LOGI(message);
      }
      std::string result_message;
      WrapHeader(message, result_message);
      if (base::SendNoSigPipe(socket_guard_.Get(), result_message.c_str(),
                              result_message.size()) == -1) {
        LOGE("send error: " << GetErrorMessage() << " message:" << message);
        if (listener_) {
          listener_->OnError(shared_from_this(), GetErrorMessage(),
                             "UsbClient::WriteMessage send data failed.");
        }
        break;
      }
    }
  }
  if (listener_ && is_connected_.exchange(false, std::memory_order_relaxed)) {
    listener_->OnClose(shared_from_this(), GetErrorMessage(),
                       "writer thread finished");
  }
  LOGI("UsbClient: WriteMessage thread exit.");
}

void UsbClient::StartWriter() {
  write_thread_.submit(
      [client_ptr = shared_from_this()]() { client_ptr->WriteMessage(); });
}

void UsbClient::DisconnectInternal() {
  // DisconnectInternal only handles transport/read-loop shutdown. Stop()
  // idempotence is guarded by stop_started_.
  stopping_.store(true, std::memory_order_relaxed);
  incoming_message_queue_.put(std::move(kMessageQuit));
  outgoing_message_queue_.put(std::move(kMessageQuit));
  socket_guard_.Reset();
}

bool UsbClient::Send(const std::string &message) {
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

void UsbClient::Stop() {
  bool expected = false;
  if (!stop_started_.compare_exchange_strong(expected, true,
                                             std::memory_order_acq_rel,
                                             std::memory_order_acquire)) {
    LOGI("UsbClient: Stop already in progress or completed.");
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
  connect_status_ = USBConnectStatus::DISCONNECTED;

  auto end_time = std::chrono::steady_clock::now();
  auto duration = std::chrono::duration_cast<std::chrono::milliseconds>(
                      end_time - start_time)
                      .count();
  LOGI("UsbClient: Stop finished in " << duration << "ms");
}

void UsbClient::SendInternal(const std::string &message) {
  if (connect_status_ != USBConnectStatus::CONNECTED) {
    LOGW("current usb client is not connected");
    return;
  }
  std::string non_const_message = message;
  outgoing_message_queue_.put(std::move(non_const_message));
}

UsbClient::~UsbClient() { Stop(); }

}  // namespace socket_server
}  // namespace debugrouter
