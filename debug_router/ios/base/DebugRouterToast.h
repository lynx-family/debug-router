// Copyright 2024 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

#include <objc/NSObjCRuntime.h>
@interface DebugRouterToast : NSObject

// show toast safely on main thread
+ (void)showToast:(nullable NSString *)message withTime:(int)during_time;

@end
