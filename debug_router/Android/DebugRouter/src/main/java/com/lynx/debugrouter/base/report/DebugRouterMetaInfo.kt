// Copyright 2023 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

package com.lynx.debugrouter.base.report;

class DebugRouterMetaInfo {
    lateinit var debugRouterVersion:String;
    lateinit var appProcessName:String;

    constructor(debugRouterVersion: String, appProcessName: String) {
        this.debugRouterVersion = debugRouterVersion
        this.appProcessName = appProcessName
    }
}