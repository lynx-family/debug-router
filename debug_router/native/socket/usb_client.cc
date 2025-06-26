// Copyright 2024 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

#include "debug_router/native/socket/usb_client.h"

#include "debug_router/native/core/util.h"
#include "debug_router/native/log/logging.h"
#include "debug_router/native/socket/socket_server_api.h"

#ifdef _WIN32
#include <winsock2.h>
#else
#include <errno.h>
#include <sys/socket.h>
#include <unistd.h>
#endif

namespace debugrouter {
namespace socket_server {

int GetErrorMessage() {
#ifdef _WIN32
  return WSAGetLastError();
#else
  return errno;
#endif
}

UsbClient::UsbClient(SocketType socket_fd) : socket_guard_(socket_fd) {
  LOGI("UsbClient: Constructor.");
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
  LOGI("UsbClient: StartUp.");
  work_thread_.submit([client_ptr = shared_from_this(), listener]() {
    client_ptr->StartInternal(listener);
  });
}

void UsbClient::StartInternal(
    const std::shared_ptr<UsbClientListener> &listener) {
  LOGI("UsbClient: StartInternal.");
  connect_status_ = USBConnectStatus::CONNECTING;
  LOGI("StartInternal, listener is:" << listener.get());
  listener_ = listener;
  StartReader();
  StartWriter();
}

bool UsbClient::ReadAndCheckMessageHeader(char *header) {
  if (!Read(header, kFrameHeaderLen)) {
    LOGE("read header data error.");
    return false;
  }
  return util::CheckHeaderThreeBytes(header);
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

bool UsbClient::Read(char *buffer, uint32_t read_size) {
  LOGI("To Read:" << read_size);
  int64_t start = 0;
  while (start < read_size) {
    int64_t read_data_len =
        recv(socket_guard_.Get(), buffer + start, read_size - start, 0);
    LOGI("read_data_len:" << read_data_len);
    if (read_data_len <= 0) {
      LOGE("Read: read_data_len <= 0 :"
           << "read target count:" << (read_size - start)
           << " read_data_len:" << read_data_len);
      return false;
    }
    start = start + read_data_len;
  }
  if (start != read_size) {
    LOGE("Read: read data count > read_size");
    return false;
  }
  return true;
}

void UsbClient::ReadMessage() {
  LOGI("UsbClient: ReadMessage:" << socket_guard_.Get());
  bool isFirst = true;
  while (true) {
    char header[kFrameHeaderLen];
    memset(header, 0, kFrameHeaderLen);
    LOGI("UsbClient: start check message header.");
    if (!ReadAndCheckMessageHeader(header)) {
      LOGW("UsbClient: don't match DebugRouter protocol:");
      // need DebugRouterReport to report invailed client.
      for (int i = 0; i < kFrameHeaderLen; i++) {
        LOGE("header " << i << " : #" << util::CharToUInt32(header[i]) << "#");
      }
      if (!isFirst && listener_) {
        listener_->OnError(shared_from_this(), GetErrorMessage(),
                           "ReadAndCheckMessageHeader error: don't match "
                           "DebugRouter protocol");
      }
      break;
    }
    if (isFirst) {
      LOGI("UsbClient: handle first frame.");
      if (listener_) {
        listener_->OnOpen(shared_from_this(), ConnectionStatus::kConnected,
                          "Init Success!");
      }
      isFirst = false;
    }
    char payload_size[kPayloadSizeLen];
    if (!Read(payload_size, kPayloadSizeLen)) {
      LOGE("read payload data error: " << GetErrorMessage());
      if (listener_) {
        listener_->OnError(shared_from_this(), GetErrorMessage(),
                           "read payload size data error.");
      }
      break;
    }

    uint32_t payload_size_int =
        util::DecodePayloadSize(payload_size, kPayloadSizeLen);
    LOGI("payload_size_int:" << payload_size_int);

    if (!util::CheckHeaderFourthByte(header, payload_size_int)) {
      LOGE("CheckHeader failed: Drop This Frame!");
      for (int i = 0; i < kFrameHeaderLen; i++) {
        LOGE("header " << i << " : #" << util::CharToUInt32(header[i]) << "#");
      }
      continue;
    }
    std::unique_ptr<char[]> payload(new char[payload_size_int]);
    if (!Read(payload.get(), payload_size_int)) {
      LOGI("read payload data error: " << GetErrorMessage());
      if (listener_) {
        listener_->OnError(shared_from_this(), GetErrorMessage(),
                           "read payload data error:");
      }
      break;
    }

    std::string payload_str(payload.get(), payload_size_int);

    LOGI("[RX]:" << payload_str);
    incoming_message_queue_.put(std::move(payload_str));
  }
  // end read loop.
  LOGI("UsbClient: ReadMessage finished.");
  if (listener_) {
    listener_->OnClose(shared_from_this(), GetErrorMessage(),
                       "ReadMessage finished");
  }
  LOGI("UsbClient: ReadMessage thread exit.");
  incoming_message_queue_.put(std::move(kMessageQuit));
  outgoing_message_queue_.put(std::move(kMessageQuit));
}

void UsbClient::StartReader() {
  LOGI("UsbClient: start reader thread.");
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
        LOGI("UsbClient: listener exists, do OnMessage.");
        listener_->OnMessage(shared_from_this(), message);
      }
    } else {
      LOGI("UsbClient: MessageDispatcherFunc receive empty message.");
    }
  }
  LOGI("UsbClient: message dispatcher finished.");
}

void UsbClient::StartMessageDispatcher() {
  LOGI("UsbClient: startMessageDispatcher.");

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
      LOGI("UsbClient: WriteMessage receive MESSAGE_QUIT.");
      break;
    }
    if (message.length() > 0) {
      LOGI("UsbClient: [TX]:");
      LOGI(message);
      std::string result_message;
      WrapHeader(message, result_message);
      if (send(socket_guard_.Get(), result_message.c_str(),
               result_message.size(), 0) == -1) {
        LOGE("send error: " << GetErrorMessage() << " message:" << message);
        if (listener_) {
          listener_->OnError(shared_from_this(), GetErrorMessage(),
                             "UsbClient::WriteMessage send data failed.");
        }
        break;
      }
    } else {
      LOGI("UsbClient: WriteMessage receive empty message.");
    }
  }
  LOGI("UsbClient: WriteMessage finished.");
  if (listener_) {
    listener_->OnClose(shared_from_this(), GetErrorMessage(),
                       "writer thread finished");
  }
  LOGI("UsbClient: WriteMessage thread exit.");
}

void UsbClient::StartWriter() {
  LOGI("UsbClient: start writer thread.");
  write_thread_.submit(
      [client_ptr = shared_from_this()]() { client_ptr->WriteMessage(); });
}

void UsbClient::DisconnectInternal() {
  LOGI("UsbClient: DisconnectInternal.");
  incoming_message_queue_.put(std::move(kMessageQuit));
  outgoing_message_queue_.put(std::move(kMessageQuit));
  socket_guard_.Reset();
}

bool UsbClient::Send(const std::string &message) {
  LOGI("UsbClient: Send.");
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
  LOGI("UsbClient: Stop.");
  DisconnectInternal();
  dispatch_thread_.shutdown();
  write_thread_.shutdown();
  read_thread_.shutdown();
  work_thread_.shutdown();
  incoming_message_queue_.clear();
  outgoing_message_queue_.clear();
  connect_status_ = USBConnectStatus::DISCONNECTED;
}

void UsbClient::SendInternal(const std::string &message) {
  LOGI("UsbClient: SendInternal.");
  if (connect_status_ != USBConnectStatus::CONNECTED) {
    LOGI("current usb client is not connected:" << message);
    return;
  }
  std::string non_const_message = message;
  outgoing_message_queue_.put(std::move(non_const_message));
}

UsbClient::~UsbClient() {
  LOGI("UsbClient: ~UsbClient.");
  Stop();
}

}  // namespace socket_server
}  // namespace debugrouter
