// Copyright 2023 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

#import <TargetConditionals.h>

#if TARGET_OS_IOS
#import <UIKit/UIKit.h>
#endif

NS_ASSUME_NONNULL_BEGIN

#define DEPRECATED_API __attribute__((deprecated))

@protocol DebugRouterSlotDelegate <NSObject>

@required
- (NSString *)getTemplateUrl;
- (void)onMessage:(NSString *)message WithType:(NSString *)type;

@end

@interface DebugRouterSlot : NSObject

@property(readwrite) int session_id;
@property(readwrite, weak) id<DebugRouterSlotDelegate> delegate;
@property(readwrite, nonnull) NSString *type;

- (int)plug;
- (void)pull;
- (void)send:(NSString *)message;
- (void)sendData:(NSString *)data WithType:(NSString *)type;
- (void)sendData:(NSString *)data WithType:(NSString *)type WithMark:(int)mark DEPRECATED_API;
;
- (void)sendAsync:(NSString *)message;
- (void)sendDataAsync:(NSString *)data WithType:(NSString *)type;
- (void)sendDataAsync:(NSString *)data WithType:(NSString *)type WithMark:(int)mark DEPRECATED_API;

// delegate methods
- (nonnull NSString *)getTemplateUrl;
- (void)onMessage:(NSString *)message WithType:(NSString *)type;
- (UIView *)getTemplateView;

// dispatch specific messages
- (void)dispatchDocumentUpdated DEPRECATED_API;
- (void)dispatchFrameNavigated:(NSString *)url DEPRECATED_API;
- (void)dispatchScreencastVisibilityChanged:(BOOL)status DEPRECATED_API;
- (void)clearScreenCastCache DEPRECATED_API;
- (void)sendScreenCast:(NSString *)data andMetadata:(NSDictionary *)metadata DEPRECATED_API;

@end

NS_ASSUME_NONNULL_END
