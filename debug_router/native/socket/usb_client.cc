// Copyright 2024 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

#include "debug_router/native/socket/usb_client.h"

#include "debug_router/native/log/logging.h"
#include "debug_router/native/socket/socket_server_api.h"
#include "debug_router/native/socket/util.h"

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

void UsbClient::CloseClientSocket(SocketType socket_fd_) {
  LOGI("CloseClientSocket" << socket_fd_);
  std::lock_guard<std::mutex> lock(mutex_);
  if (socket_fd_ == kInvalidSocket) {
    return;
  }
#ifdef _WIN32
  if (closesocket(socket_fd_) != 0) {
    LOGE("close socket error:" << GetErrorMessage());
  }
#else
  if (close(socket_fd_) != 0) {
    LOGE("close socket error:" << GetErrorMessage());
  }
#endif
  socket_fd_ = kInvalidSocket;
}

UsbClient::UsbClient(SocketType socket_fd) : socket_fd_(socket_fd) {
  LOGI("UsbClient: Constructor.");
}

void UsbClient::SetConnectStatus(USBConnectStatus status) {
  work_thread_.submit([client_ptr = shared_from_this(), status]() {
    client_ptr->connect_status_ = status;
  });
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
  listener_ = listener;
  latch_ = std::make_unique<CountDownLatch>(kThreadCount);
  StartReader(socket_fd_);
  StartWriter(socket_fd_);
}

bool UsbClient::ReadAndCheckMessageHeader(char *header, SocketType socket_fd_) {
  if (!Read(socket_fd_, header, kFrameHeaderLen)) {
    LOGE("read header data error.");
    return false;
  }
  return CheckHeaderThreeBytes(header);
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

bool UsbClient::Read(SocketType socket_fd_, char *buffer, uint32_t read_size) {
  LOGI("To Read:" << read_size);
  int64_t start = 0;
  while (start < read_size) {
    int64_t read_data_len =
        recv(socket_fd_, buffer + start, read_size - start, 0);
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

void UsbClient::ReadMessage(SocketType socket_fd_) {
  LOGI("UsbClient: ReadMessage:" << socket_fd_);
  bool isFirst = true;
  while (true) {
    char header[kFrameHeaderLen];
    memset(header, 0, kFrameHeaderLen);
    LOGI("UsbClient: start check message header.");
    if (!ReadAndCheckMessageHeader(header, socket_fd_)) {
      LOGW("UsbClient: don't match DebugRouter protocol:");
      // need DebugRouterReport to report invailed client.
      for (int i = 0; i < kFrameHeaderLen; i++) {
        LOGE("header " << i << " : #" << CharToUInt32(header[i]) << "#");
      }
      if (!isFirst && listener_) {
        listener_->OnError(shared_from_this(), GetErrorMessage(),
                           "protocol error: ReadAndCheckMessageHeader");
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
    if (!Read(socket_fd_, payload_size, kPayloadSizeLen)) {
      LOGE("read payload data error: " << GetErrorMessage());
      if (listener_) {
        listener_->OnError(shared_from_this(), GetErrorMessage(),
                           "protocol error: payload_size.");
      }
      break;
    }

    uint32_t payload_size_int =
        DecodePayloadSize(payload_size, kPayloadSizeLen);
    LOGI("payload_size_int:" << payload_size_int);

    if (!CheckHeaderFourthByte(header, payload_size_int)) {
      LOGE("CheckHeader failed: Drop This Frame!");
      for (int i = 0; i < kFrameHeaderLen; i++) {
        LOGE("header " << i << " : #" << CharToUInt32(header[i]) << "#");
      }
      continue;
    }
    char payload[payload_size_int];
    if (!Read(socket_fd_, payload, payload_size_int)) {
      LOGE("read payload data error: " << GetErrorMessage());
      if (listener_) {
        listener_->OnError(shared_from_this(), GetErrorMessage(),
                           "protocol error: PAYLOAD");
      }
      break;
    }

    std::string payload_str(payload, payload_size_int);

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
  CloseClientSocket(socket_fd_);
  incoming_message_queue_.put(std::move(kMessageQuit));
  outgoing_message_queue_.put(std::move(kMessageQuit));
  if (latch_) {
    latch_->CountDown();
  }
}

void UsbClient::ReadThreadFunc(std::shared_ptr<UsbClient> client,
                               SocketType socket_fd_) {
  client->ReadMessage(socket_fd_);
}

void UsbClient::StartReader(SocketType socket_fd_) {
  LOGI("UsbClient: start reader thread.");
  StartMessageDispatcher(socket_fd_);
  std::thread read_thread(ReadThreadFunc, shared_from_this(), socket_fd_);
  read_thread.detach();
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
    } else {
      LOGI("UsbClient: MessageDispatcherFunc receive empty message.");
    }
  }
  LOGI("UsbClient: message dispatcher finished.");
  if (latch_) {
    latch_->CountDown();
  }
}

void UsbClient::MessageDispatcherFunc(std::shared_ptr<UsbClient> client) {
  client->MessageDispatcher();
}

void UsbClient::StartMessageDispatcher(SocketType socket_fd_) {
  LOGI("UsbClient: startMessageDispatcher.");
  std::thread dispatch_message_thread(MessageDispatcherFunc,
                                      shared_from_this());
  dispatch_message_thread.detach();
}

void UsbClient::WrapHeader(const std::string &message, std::string &result) {
  const uint32_t total_size =
      static_cast<uint32_t>(kFrameHeaderLen + kPayloadSizeLen + message.size());
  result.resize(total_size);
  char *buffer = &result[0];
  char char_array[4];
  // write kFrameProtocolVersion
  IntToCharArray(kFrameProtocolVersion, char_array);
  memcpy(buffer, char_array, 4);

  // write kPTFrameTypeTextMessage
  IntToCharArray(kPTFrameTypeTextMessage, char_array);
  memcpy(buffer + 4, char_array, 4);

  // write kFrameDefaultTag
  IntToCharArray(kFrameDefaultTag, char_array);
  memcpy(buffer + 8, char_array, 4);

  // write len
  uint32_t len =
      static_cast<uint32_t>(kFrameHeaderLen + kPayloadSizeLen + message.size());
  IntToCharArray(len, char_array);
  memcpy(buffer + 12, char_array, 4);

  // write message.size()
  IntToCharArray(static_cast<uint32_t>(message.size()), char_array);
  memcpy(buffer + 16, char_array, 4);

  // write message
  memcpy(buffer + 20, message.c_str(), message.size());
}

void UsbClient::WriteMessage(SocketType socket_fd_) {
  LOGI("UsbClient: WriteMessage:" << socket_fd_);
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
      if (send(socket_fd_, result_message.c_str(), result_message.size(), 0) ==
          -1) {
        LOGE("send error: " << GetErrorMessage() << " message:" << message);
        if (listener_) {
          listener_->OnError(shared_from_this(), GetErrorMessage(),
                             "protocol error: send data");
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
  CloseClientSocket(socket_fd_);
  if (latch_) {
    latch_->CountDown();
  }
}

void UsbClient::WriteThreadFunc(std::shared_ptr<UsbClient> client,
                                SocketType socket_fd_) {
  client->WriteMessage(socket_fd_);
}

void UsbClient::StartWriter(SocketType socket_fd_) {
  LOGI("UsbClient: start writer thread.");
  std::thread write_thread(WriteThreadFunc, shared_from_this(), socket_fd_);
  write_thread.detach();
}

void UsbClient::Stop() {
  LOGI("UsbClient: Stop.");
  work_thread_.submit([client_ptr = shared_from_this()]() {
    client_ptr->DisconnectInternal();
  });
  work_thread_.shutdown();
}

void UsbClient::DisconnectInternal() {
  LOGI("UsbClient: DisconnectInternal.");
  CloseClientSocket(socket_fd_);
  if (!latch_) {
    incoming_message_queue_.put(std::move(kMessageQuit));
    outgoing_message_queue_.put(std::move(kMessageQuit));

    LOGI("UsbClient: DisconnectInternal waiting for threads exit.");
    latch_->Await();
    connect_status_ = USBConnectStatus::DISCONNECTED;

    incoming_message_queue_.clear();
    outgoing_message_queue_.clear();
    latch_ = nullptr;
    LOGI("UsbClient: DisconnectInternal successfully.");
  }
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
  CloseClientSocket(socket_fd_);
}

}  // namespace socket_server
}  // namespace debugrouter
