// Copyright 2023 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

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

void SocketServer::setEnableServer(bool enable) {
  LOGI("SocketServer::setEnableServer:" << enable);
  // notify only when transition from false to true
  if (!is_running_.exchange(enable, std::memory_order_relaxed) && enable) {
    running_condition_.notify_one();
  }
}

void SocketServer::StartServer() { setEnableServer(true); }

void SocketServer::StopServer() {
  std::shared_ptr<UsbClient> current_client;
  std::shared_ptr<UsbClient> pending_client;
  setEnableServer(false);
  // Close socket if it's valid
  SocketType socket_fd = socket_fd_.load(std::memory_order_acquire);
  if (socket_fd != kInvalidSocket) {
#ifdef _WIN32
    shutdown(socket_fd, SD_BOTH);
#else
    shutdown(socket_fd, SHUT_RDWR);
#endif
  }

  Close();
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

void SocketServer::ThreadFunc(std::shared_ptr<SocketServer> socket_server) {
  int count = 0;
  while (true) {
    {
      std::unique_lock lock(socket_server->running_mutex_);
      socket_server->running_condition_.wait(lock, [=]() {
        return socket_server->is_running_.load(std::memory_order_relaxed) ==
               true;
      });
    }
    LOGI("Init start:" << count);
    socket_server->Start();
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
  if (socket_fd == kInvalidSocket) {
    return;
  }
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
  Close();
}

}  // namespace socket_server
}  // namespace debugrouter
