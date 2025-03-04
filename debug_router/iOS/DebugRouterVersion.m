// Copyright 2023 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

#import "DebugRouterVersion.h"

@implementation DebugRouterVersion

+ (NSString *)versionString {
// source build will define DebugRouter_POD_VERSION
// binary build will replace string by .rock-package.yml
#ifndef DebugRouter_POD_VERSION
#define DebugRouter_POD_VERSION @"9999_2.0.0"
#endif
  return [DebugRouter_POD_VERSION substringFromIndex:5];
}
@end
