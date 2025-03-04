// Copyright 2023 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

package com.lynx.debugrouter

import com.lynx.debugrouter.app.MessageHandleResult
import com.lynx.debugrouter.app.MessageHandler
import com.lynx.debugrouter.log.LLog
import com.lynx.debugrouter.base.usb.USBTransTemplateUtil

class OpenUsbTransTemplateSwitchHandler : MessageHandler {
    override fun handle(params: MutableMap<String, String>?): MessageHandleResult {
        LLog.i(TAG, "OpenUsbTransTemplateSwitchHandler handle")
        USBTransTemplateUtil.setDebugPlatformSupport(true)
        return MessageHandleResult()
    }

    override fun getName(): String {
        return "App.OpenUsbTransTemplateSwitch"
    }

    companion object {
        const val TAG = "USBTransTemplateSwitch"
    }
}