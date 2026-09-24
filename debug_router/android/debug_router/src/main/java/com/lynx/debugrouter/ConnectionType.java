// Copyright 2024 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

package com.lynx.debugrouter;

import androidx.annotation.Keep;

// USB is the existing API name for connections accepted by the TCP server.
@Keep public enum ConnectionType { WebSocket, USB }
