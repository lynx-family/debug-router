// Copyright 2023 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

package com.lynx.debugrouter.base.usb

import android.util.Log
import com.lynx.debugrouter.base.MessageTransceiver
import com.lynx.debugrouter.base.MessageTransceiverStateListener
import com.lynx.debugrouter.base.report.DebugRouterReportServiceUtil
import com.lynx.debugrouter.base.service.DebugRouterServiceCenter
import com.lynx.debugrouter.base.usb.IUSBHijackService
import org.json.JSONException
import org.json.JSONObject
import java.util.TreeSet
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit

class TemplateData : Comparable<TemplateData> {
    var seqId: Int = 0
    var data: String

    constructor(seqId: Int, data: String) {
        this.seqId = seqId
        this.data = data
    }


    override fun compareTo(other: TemplateData): Int {
        return if (this.seqId < other.seqId) {
            -1
        } else if (this.seqId > other.seqId) {
            1
        } else {
            0
        }
    }

}

class TemplateFileSize {
    var seqCount: Int = -1
    var fileLen: Int = -1

    constructor(seqSize: Int, fileLen: Int) {
        this.seqCount = seqSize
        this.fileLen = fileLen
    }

    fun isError(): Boolean {
        return seqCount <= ERROR_VALUE || fileLen <= ERROR_VALUE
    }

    companion object {
        const val ERROR_VALUE = -2
        const val TIME_OUT = -3
    }
}

object USBTransTemplateUtil {
    private const val TAG = "USBTransTemplateUtil"

    private val ipPortRegex = Regex("""(?:http:\/\/|http%3A%2F%2F)((?:[0-9]{1,3}(?:\.|%2E)){3}[0-9]{1,3})(?::|%3A)([0-9]{1,5})(?:\/|%2F)""")
    private val executor = Executors.newScheduledThreadPool(1)

    @Volatile
    private var mUSBIsEnabled = false

    @Volatile
    private var mTransceiver: MessageTransceiver? = null

    private var mIsDebugPlatformSupport = false

    private var responseMap: MutableMap<Long, TreeSet<TemplateData>> = ConcurrentHashMap()
    private var responseSize: MutableMap<Long, TemplateFileSize> = ConcurrentHashMap()
    private var requestTimeOutTask: MutableMap<Long, ScheduledFuture<*>> = ConcurrentHashMap()

    @Volatile
    private var globalRequestId: Long = 0

    private val urlMap: MutableMap<Pair<String, String>, Boolean> = ConcurrentHashMap()

    fun addInterceptor() {
        Log.i(TAG, "reflect to add Interceptor")
        try {
            val usbService = DebugRouterServiceCenter.instance().getService(IUSBHijackService::class.java)
            if (usbService == null) {
                Log.i(TAG, "usbService is null.")
                return
            }
            usbService.addInterceptor()
        } catch (e: Exception) {
            Log.e(TAG, e.message ?: "")
        }
    }

    fun setUSBTransceiver(transceiver: MessageTransceiver) {
        Log.i(TAG, "set USB Transceiver for USBTransTemplate")
        mTransceiver = transceiver
        mTransceiver?.setStateListener(USBTransTemplateTransceiverListener)
    }


    fun isUSBTransTemplateAvailable(): Boolean {
        return mUSBIsEnabled && mIsDebugPlatformSupport
    }

    fun updateUrlSet(url: String) {
        ipPortRegex.find(url)?.let {
            val groupValues = it.groupValues
            if (groupValues.size != 3) {
                Log.e(TAG, "ipPort is illegal: $url")
                return
            }
            urlMap.put(Pair(groupValues[1], groupValues[2]), true)
        }
    }

    fun getUrlSet(): Set<Pair<String, String>> {
        return urlMap.keys
    }

    fun requestData(url: String): Long {
        val reqId = globalRequestId++
        responseMap[reqId] = TreeSet()
        val task = Runnable {
            requestTimeOutTask.remove(reqId)
            Log.w(TAG, "reqId:$reqId, url: $url is timeout")
            responseSize[reqId] = TemplateFileSize(TemplateFileSize.TIME_OUT, TemplateFileSize.TIME_OUT)
            responseMap[reqId] = TreeSet()
        }
        val future = executor.schedule(task, 8, TimeUnit.SECONDS)
        requestTimeOutTask[reqId] = future
        mTransceiver?.send("""{"data":{"data":{"client_id":-1,"message": "{\"method\":\"DownloadTemplateByUsb\",\"params\":{\"requestId\":${reqId}, \"url\":\"${url}\"}}","session_id": -1},"sender": -1,"type": "CDP"},"event": "Customized"}""")

        return reqId
    }

    fun receiveData(reqId: Long, data: TemplateData) {
        requestTimeOutTask[reqId]?.let {
            responseMap[reqId]?.add(data)
        }
    }

    fun receiveResponseSize(reqId: Long, size: TemplateFileSize) {
        requestTimeOutTask[reqId]?.let {
            it.cancel(true)
            requestTimeOutTask.remove(reqId)
            responseSize[reqId] = size
        }
    }

    fun getTemplateData(reqId: Long): Pair<TreeSet<TemplateData>, TemplateFileSize>? {
        val size = responseSize[reqId] ?: return null
        if (size.isError()) {
            return Pair(TreeSet(), size)
        }
        val dataSet = responseMap[reqId]
        dataSet?.let {
            if (it.size == size.seqCount) {
                return Pair(dataSet, size)
            }
        }
        return null
    }

    fun setDebugPlatformSupport(support: Boolean) {
        mIsDebugPlatformSupport = support
    }

    object USBTransTemplateTransceiverListener :
        MessageTransceiverStateListener {
        override fun onOpen(transceiver: MessageTransceiver?) {
            Log.i(TAG, "onOpen")
            mUSBIsEnabled = true
            urlMap.clear()
        }

        override fun onClose(transceiver: MessageTransceiver?, code: Int, reason: String?) {
            mUSBIsEnabled = false
        }

        override fun onMessage(transceiver: MessageTransceiver?, text: String?) {
            text?.let { msg ->
                // {"event":"Customized","data":{"type":"OpenCard","data":{"type":"url","url":"xxx"},"sender":1},"to":5,"from":1}
                if (msg.indexOf("OpenCard") != -1) {
                    val messageObj = JSONObject(msg)
                    (((messageObj.opt("data") as? JSONObject)?.opt("data") as? JSONObject)?.opt("url") as? String)?.let {
                        Log.i(TAG, "OpenCard url: $it")
                        USBTransTemplateUtil.updateUrlSet(it)
                        reportOpenCardUrl(it)
                    }
                    return
                }
            }

        }

        override fun onError(transceiver: MessageTransceiver?, t: Throwable?) {
            mUSBIsEnabled = false
        }
    }

    private fun reportOpenCardUrl(url: String) {
        val jsonObject = JSONObject()
        try {
            jsonObject.put("url", url)
        } catch (e: JSONException) {
            Log.e(TAG, "reportOpenCardUrl:$e")
        }
        DebugRouterReportServiceUtil.report("USBOpenCardUrl", jsonObject, null, null)
    }

}