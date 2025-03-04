// Copyright 2023 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

package com.lynx.debugrouter

import com.lynx.debugrouter.app.MessageHandleResult
import com.lynx.debugrouter.app.MessageHandleResult.CODE_HANDLE_FAILED
import com.lynx.debugrouter.app.MessageHandler
import com.lynx.debugrouter.log.LLog
import com.lynx.debugrouter.base.usb.TemplateData
import com.lynx.debugrouter.base.usb.TemplateFileSize
import com.lynx.debugrouter.base.usb.USBTransTemplateUtil

class ReceiveTemplateByUsbHandler : MessageHandler {
    override fun handle(params: MutableMap<String, String>?): MessageHandleResult {
        LLog.i(TAG, "ReceiveTemplateByUsbHandler handle")
        val reqId = params?.get("requestId")?.toLong() ?: -1
        if (reqId == -1L) {
            LLog.e(TAG, "reqId == $reqId")
            return MessageHandleResult(CODE_HANDLE_FAILED, "illegal message: reqId == $reqId")
        }
        LLog.i(TAG, "Receive data reqId: $reqId")
        val error = params?.get("error")
        if (error != null) {
            LLog.i(TAG, "Receive error: $error")
            USBTransTemplateUtil.receiveResponseSize(reqId, TemplateFileSize(TemplateFileSize.ERROR_VALUE, TemplateFileSize.ERROR_VALUE))
            return MessageHandleResult()
        }
        val data = params?.get("data")
        val seqId = params?.get("seqId")?.toInt() ?: -1

        if (seqId == -1 || data == null) {
            LLog.e(TAG, "seqId = $seqId, data == $data")
            return MessageHandleResult(CODE_HANDLE_FAILED, "illegal message: seqId = $seqId, data == $data")
        }

        USBTransTemplateUtil.receiveData(reqId, TemplateData(seqId, data))
        val seqCount = params["seq_count"]?.toInt() ?: -1
        val temLen = params["tem_file_len"]?.toInt() ?: -1
        if (seqCount != -1 && temLen != -1) {
            LLog.i(TAG, "Receive ResponseSize: seqCount = $seqCount, tem_file_len = $temLen")
            USBTransTemplateUtil.receiveResponseSize(reqId, TemplateFileSize(seqCount, temLen))
        } else {
            LLog.e(TAG, "seqCount = $seqCount, tem_file_len = $temLen")
            return MessageHandleResult(CODE_HANDLE_FAILED, "illegal seqCount or temLen")
        }
        return MessageHandleResult()
    }

    override fun getName(): String {
        return "App.ReceiveTemplateByUsb"
    }

    companion object {
        const val TAG = "USBTransTemplateReceive"
    }
}