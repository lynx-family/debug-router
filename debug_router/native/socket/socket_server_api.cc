// Copyright 2023 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

#include <chrono>

#include "debug_router/native/socket/socket_server_type.h"
#ifdef _WIN32
#include "debug_router/native/socket/win/socket_server_win.h"
#else
#include "debug_router/native/socket/posix/socket_server_posix.h"
#endif
#include "debug_router/native/core/util.h"
#include "debug_router/native/thread/debug_router_executor.h"

namespace debugrouter {
namespace socket_server {

std::shared_ptr<SocketServer> SocketServer::CreateSocketServer(
    const std::shared_ptr<SocketServerConnectionListener> &listener) {
#ifdef _WIN32
  return std::make_shared<SocketServerWin>(listener);
#else
  return std::make_shared<SocketServerPosix>(listener);
#endif
}

SocketServer::SocketServer(
    const std::shared_ptr<SocketServerConnectionListener> &listener)
    : listener_(listener), usb_client_(nullptr) {
  clean_executor_.init();
}

void SocketServer::ScheduleClientStop(
    const std::shared_ptr<UsbClient> &client) {
  if (!client) {
    return;
  }
  clean_executor_.submit([client]() { client->Stop(); });
}

bool SocketServer::Send(const std::string &message) {
  std::shared_ptr<UsbClient> client;
  {
    std::lock_guard<std::mutex> lock(client_lock_);
    client = usb_client_;
  }
  if (!client) {
    LOGI("SocketServerApi Send: client is null.");
    return false;
  }
  return client->Send(message);
}

#if defined(DEBUGROUTER_ENABLE_IOS_USB_START_PORT)
bool SocketServer::SetStartPort(int32_t start_port) {
  if (start_port <= 0 || start_port > UINT16_MAX - kTryPortCount + 1) {
    return false;
  }
  start_port_.store(static_cast<PORT_TYPE>(start_port),
                    std::memory_order_relaxed);
  return true;
}

PORT_TYPE SocketServer::GetStartPort() {
  return start_port_.load(std::memory_order_relaxed);
}
#endif

void SocketServer::HandleOnOpenStatus(std::shared_ptr<UsbClient> client,
                                      int32_t code, const std::string &reason) {
  thread::DebugRouterExecutor::GetInstance().Post([=]() {
    std::shared_ptr<UsbClient> old_client_;
    bool should_notify = false;
    {
      std::lock_guard<std::mutex> lock(client_lock_);
      if (temp_usb_client_ != client) {
        LOGI("SocketServerApi OnOpen: stale client open ignored.");
        return;
      }
      old_client_ = usb_client_;
      usb_client_ = client;
      should_notify = true;
    }
    LOGI("SocketServerApi OnOpen: replace old client.");
    if (old_client_ && old_client_ != client) {
      LOGI("SocketServerApi HandleOnOpenStatus: stop old client.");
      ScheduleClientStop(old_client_);
    }
    if (should_notify) {
      if (auto listener = listener_.lock()) {
        listener->OnStatusChanged(kConnected, code, reason);
      }
    }
  });
}

void SocketServer::HandleOnMessageStatus(std::shared_ptr<UsbClient> client,
                                         const std::string &message) {
  thread::DebugRouterExecutor::GetInstance().Post([=]() {
    bool is_current_client = false;
    {
      std::lock_guard<std::mutex> lock(client_lock_);
      is_current_client = usb_client_ && usb_client_ == client;
    }
    if (!is_current_client) {
      LOGI("SocketServerApi OnMessage: client is null or not match.");
      return;
    }
    if (auto listener = listener_.lock()) {
      listener->OnMessage(message);
    }
  });
}

void SocketServer::HandleOnCloseStatus(std::shared_ptr<UsbClient> client,
                                       ConnectionStatus status, int32_t code,
                                       const std::string &reason) {
  thread::DebugRouterExecutor::GetInstance().Post([=]() {
    std::shared_ptr<UsbClient> client_to_stop;
    bool should_notify = false;
    // True if this callback tore down a client that had already been
    // promoted to usb_client_. Such clients must still produce a status
    // notification even if their close/error races with a newer accept.
    bool cleared_promoted_client = false;
    {
      std::lock_guard<std::mutex> lock(client_lock_);
      const bool superseded_by_new_accept =
          temp_usb_client_ && temp_usb_client_ != client;
      if (superseded_by_new_accept || !usb_client_ || usb_client_ != client) {
        if (usb_client_ == client) {
          usb_client_ = nullptr;
          cleared_promoted_client = true;
        }
        if (temp_usb_client_ == client) {
          temp_usb_client_ = nullptr;
        }
        client_to_stop = client;
      } else {
        LOGI(
            "SocketServerApi HandleOnCloseStatus: close curr client for "
            "OnClose.");
        client_to_stop = usb_client_;
        usb_client_ = nullptr;
        if (temp_usb_client_ == client) {
          temp_usb_client_ = nullptr;
        }
        should_notify = true;
      }
    }
    if (!should_notify && !cleared_promoted_client) {
      LOGI(
          "SocketServerApi OnClose: stale client closed, stop stale client "
          "without notifying current connection.");
      if (client_to_stop) {
        ScheduleClientStop(client_to_stop);
      }
      return;
    }
    if (client_to_stop) {
      ScheduleClientStop(client_to_stop);
    }
    if (auto listener = listener_.lock()) {
      listener->OnStatusChanged(status, code, reason);
    }
  });
}

void SocketServer::HandleOnErrorStatus(std::shared_ptr<UsbClient> client,
                                       ConnectionStatus status, int32_t code,
                                       const std::string &reason) {
  thread::DebugRouterExecutor::GetInstance().Post([=]() {
    std::shared_ptr<UsbClient> client_to_stop;
    bool should_notify = false;
    // True if this callback tore down a client that had already been
    // promoted to usb_client_. Such clients must still produce a status
    // notification even if their close/error races with a newer accept.
    bool cleared_promoted_client = false;
    {
      std::lock_guard<std::mutex> lock(client_lock_);
      const bool superseded_by_new_accept =
          temp_usb_client_ && temp_usb_client_ != client;
      if (superseded_by_new_accept || !usb_client_ || usb_client_ != client) {
        if (usb_client_ == client) {
          usb_client_ = nullptr;
          cleared_promoted_client = true;
        }
        if (temp_usb_client_ == client) {
          temp_usb_client_ = nullptr;
        }
        client_to_stop = client;
      } else {
        LOGI(
            "SocketServerApi HandleOnErrorStatus: close curr client for "
            "OnError.");
        client_to_stop = usb_client_;
        usb_client_ = nullptr;
        if (temp_usb_client_ == client) {
          temp_usb_client_ = nullptr;
        }
        should_notify = true;
      }
    }
    if (!should_notify && !cleared_promoted_client) {
      LOGI(
          "SocketServerApi OnError: stale client errored, stop stale client "
          "without notifying current connection.");
      if (client_to_stop) {
        ScheduleClientStop(client_to_stop);
      }
      return;
    }
    if (client_to_stop) {
      ScheduleClientStop(client_to_stop);
    }
    if (auto listener = listener_.lock()) {
      listener->OnStatusChanged(status, code, reason);
    }
  });
}

void SocketServer::NotifyInit(int32_t code, const std::string &info) {
  thread::DebugRouterExecutor::GetInstance().Post([=]() {
    if (auto listener = listener_.lock()) {
      listener->OnInit(code, info);
    }
  });
}

int32_t SocketServer::GetListeningPort() const {
  return listening_port_.load(std::memory_order_relaxed);
}

void SocketServer::SetListeningPort(int32_t port) {
  listening_port_.store(port, std::memory_order_relaxed);
}

void SocketServer::StartServer() {
  LOGI("SocketServer::StartServer");
  // notify only when transition from false to true
  bool should_notify = false;
  {
    std::lock_guard<std::mutex> lock(server_state_mutex_);
    should_notify = !is_running_;
    is_running_ = true;
  }
  if (should_notify) {
    running_condition_.notify_one();
  }
}

void SocketServer::StopServer(bool invalidate_listening_port) {
  LOGI("SocketServer::StopServer");
  std::shared_ptr<UsbClient> current_client;
  std::shared_ptr<UsbClient> pending_client;
  SocketType socket_fd;
  {
    std::lock_guard<std::mutex> lock(server_state_mutex_);
    is_running_ = false;
    if (invalidate_listening_port) {
      listening_port_.store(kInvalidPort, std::memory_order_relaxed);
    }
    socket_fd = socket_fd_.exchange(kInvalidSocket, std::memory_order_acq_rel);
  }
  // Close socket if it's valid
  if (socket_fd != kInvalidSocket) {
#ifdef _WIN32
    shutdown(socket_fd, SD_BOTH);
#else
    shutdown(socket_fd, SHUT_RDWR);
#endif
    CloseSocket(socket_fd);
  }

  {
    std::unique_lock<std::mutex> lock(server_state_mutex_);
    serving_condition_.wait(lock, [this]() { return !is_serving_; });
  }
  {
    std::lock_guard<std::mutex> lock(client_lock_);
    current_client = usb_client_;
    pending_client = temp_usb_client_;
    usb_client_ = nullptr;
    temp_usb_client_ = nullptr;
  }
  if (current_client) {
    current_client->Stop();
  }
  if (pending_client && pending_client != current_client) {
    pending_client->Stop();
  }
}

SocketType SocketServer::GetValidSocket() {
  SocketType socket_fd = socket_fd_.load(std::memory_order_acquire);
  if (socket_fd == kInvalidSocket) {
    const int32_t port = InitSocket();
    if (port == kInvalidPort) {
      return kInvalidSocket;
    }
    NotifyInit(0, "port:" + std::to_string(port));
    socket_fd = socket_fd_.load(std::memory_order_acquire);
  }
  return socket_fd;
}

void SocketServer::ThreadFunc(std::shared_ptr<SocketServer> socket_server) {
  int count = 0;
  while (true) {
    SocketType socket_fd;
    {
      std::unique_lock state_lock(socket_server->server_state_mutex_);
      socket_server->running_condition_.wait(
          state_lock, [=]() { return socket_server->is_running_; });
      socket_fd = socket_server->GetValidSocket();
      if (socket_fd == kInvalidSocket) {
        // wait for 1 second before retrying
        socket_server->running_condition_.wait_for(
            state_lock, std::chrono::milliseconds(1000));
        continue;
      }
      socket_server->is_serving_ = true;
    }
    LOGI("Init start:" << count);
    socket_server->Start(socket_fd);
    {
      std::lock_guard<std::mutex> lock(socket_server->server_state_mutex_);
      socket_server->is_serving_ = false;
    }
    socket_server->serving_condition_.notify_all();
    count++;
  }
}

void SocketServer::Init() {
  std::thread listen_thread(ThreadFunc, shared_from_this());
  listen_thread.detach();
}

// close server socket
void SocketServer::Close() {
  SocketType socket_fd =
      socket_fd_.exchange(kInvalidSocket, std::memory_order_acq_rel);
  LOGI("SocketServer::Close server socket_fd_:" << socket_fd);
  // The atomic exchange above is the only cross-thread double-close guard we
  // need here. Backend-specific CloseSocket() keeps the kInvalidSocket check so
  // all close validation remains centralized in one place.
  CloseSocket(socket_fd);
}

void SocketServer::Disconnect() {
  thread::DebugRouterExecutor::GetInstance().Post([=]() {
    std::shared_ptr<UsbClient> client_to_stop;
    {
      std::lock_guard<std::mutex> lock(client_lock_);
      client_to_stop = usb_client_;
      usb_client_ = nullptr;
      if (temp_usb_client_ == client_to_stop) {
        temp_usb_client_ = nullptr;
      }
    }
    if (client_to_stop) {
      LOGI("SocketServerApi Disconnect: stop curr client.");
      ScheduleClientStop(client_to_stop);
    }
  });
}

SocketServer::~SocketServer() {
  clean_executor_.shutdown();
  std::shared_ptr<UsbClient> current_client;
  std::shared_ptr<UsbClient> pending_client;
  {
    std::lock_guard<std::mutex> lock(client_lock_);
    current_client = usb_client_;
    pending_client = temp_usb_client_;
    usb_client_ = nullptr;
    temp_usb_client_ = nullptr;
  }
  if (current_client) {
    current_client->Stop();
  }
  if (pending_client && pending_client != current_client) {
    pending_client->Stop();
  }
}

}  // namespace socket_server
}  // namespace debugrouter
