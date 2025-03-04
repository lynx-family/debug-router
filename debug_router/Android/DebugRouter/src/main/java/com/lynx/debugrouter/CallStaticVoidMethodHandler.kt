// Copyright 2023 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

package com.lynx.debugrouter

import com.lynx.debugrouter.app.MessageHandleResult
import com.lynx.debugrouter.app.MessageHandleResult.CODE_HANDLE_FAILED
import com.lynx.debugrouter.app.MessageHandleResult.CODE_HANDLE_SUCCESSFULLY
import com.lynx.debugrouter.app.MessageHandler

/**
 * CallStaticVoidMethodHandler
 */
class CallStaticVoidMethodHandler : MessageHandler {
    override fun handle(params: MutableMap<String, String>?): MessageHandleResult {
        val className: String? = params?.get("className")
        val methodName: String? = params?.get("methodName")
        if (className == null || methodName == null) {
            return MessageHandleResult(
                CODE_HANDLE_FAILED,
                "invalid params: className: ${className}, methodName: $methodName",
                null
            )
        }
        try {
            val calledClass = Class.forName(className)
            val method = calledClass.getDeclaredMethod(methodName)
            method.isAccessible = true
            method.invoke(null)
        } catch (e: Exception) {
            return MessageHandleResult(CODE_HANDLE_FAILED, "exception: ${e.message}", null)
        }
        return MessageHandleResult(CODE_HANDLE_SUCCESSFULLY, "invoke successfully", null)
    }

    override fun getName(): String {
        return "App.CallStaticVoidMethod";
    }
}