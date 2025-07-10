// Copyright 2023 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

package com.lynx.debugrouter.app;

import java.util.Map;

/**
 * MessageHandler is used to process message received by DebugRouter.
 * <p>
 * we can use:
 * <p>
 * @link{ com.lynx.debugrouter.DebugRouter#addMessageHandler}
 * <p>
 * to add MessageHandler for processing specific message.
 */
public interface MessageHandler {
  /**
   * DebugRouter dispatch message according to MessageHandler's name,
   * <p>
   * when a MessageHandler's name match the received message, the
   * MessageHandler will handle this message(the handle method of the
   * MessageHandler will be called)
   * <p>
   * when handler need return extra result asynchronously,
   * you can use @link
   * {com.lynx.debugrouter.app.DebugRouterEventSender#sender}
   *
   * @param params handler's params: resolved from the message
   * @return return handler's result
   */
  MessageHandleResult handle(Map<String, String> params);

  /**
   * MessageHandler's name
   * <p>
   * unique identifier for MessageHandler.
   * <p>
   * It indicates which message this handler can handle.
   */
  String getName();
}
