// Copyright 2025 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

typedef NS_ENUM(NSInteger, LocalNetworkPermissionErrorCode) {
  LocalNetworkPermissionNotDetermined = -1,            // Another check is already in progress
  LocalNetworkPermissionErrorNone = 0,                 // Succeed
  LocalNetworkPermissionErrorInfoPlistMissing = 1,     // Info.plist missing
  LocalNetworkPermissionErrorTCPConnectionFailed = 2,  // TCP checking failed
  LocalNetworkPermissionErrorTimeoutFallback = 3,      // All timeout
};

typedef void (^LocalNetworkPermissionCompletion)(BOOL granted, NSError* _Nullable error);

@interface LocalNetworkPermissionChecker : NSObject

+ (void)checkPermissionWithCompletion:(LocalNetworkPermissionCompletion _Nonnull)completion;

@end

NS_ASSUME_NONNULL_END
