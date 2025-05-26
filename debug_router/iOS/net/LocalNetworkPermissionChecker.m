// Copyright 2025 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

#import "LocalNetworkPermissionChecker.h"
#import <Network/Network.h>
#import <stdatomic.h>

@interface LocalNetworkPermissionChecker () <NSNetServiceDelegate>
@property(nonatomic, strong) NSNetService *netService;
@property(nonatomic, copy) LocalNetworkPermissionCompletion completion;
@property(nonatomic, assign) BOOL didReturnResult;
@end

@implementation LocalNetworkPermissionChecker

NSString *serviceType;
static const NSTimeInterval kBonjourWaitTime = 3;
static const NSTimeInterval kGlobalTimeout = 6;

static _Atomic(int) isChecking = 0;
static LocalNetworkPermissionChecker *currentChecker = nil;

+ (void)checkPermissionWithCompletion:(LocalNetworkPermissionCompletion)completion {
  int expected = 0;
  // Thread safety
  if (!atomic_compare_exchange_strong(&isChecking, &expected, 1)) {
    NSError *error = [NSError
        errorWithDomain:@"LocalNetworkPermission"
                   code:LocalNetworkPermissionNotDetermined
               userInfo:@{
                 NSLocalizedDescriptionKey : @"Another permission check is already in progress"
               }];
    if (completion) {
      dispatch_async(dispatch_get_main_queue(), ^{
        completion(NO, error);
      });
    }
    return;
  }

  // The first check after the APP is installed will pop up a prompt to guide you to open the local
  // network.
  if (![self isInfoPlistProperlyConfigured]) {
    NSError *error = [NSError
        errorWithDomain:@"LocalNetworkPermission"
                   code:LocalNetworkPermissionErrorInfoPlistMissing
               userInfo:@{
                 NSLocalizedDescriptionKey :
                     @"Info.plist misses NSLocalNetworkUsageDescription or NSBonjourServices"
               }];
    // reset flag
    atomic_store(&isChecking, 0);
    completion(NO, error);
    return;
  }

  currentChecker = [[LocalNetworkPermissionChecker alloc] init];
  currentChecker.completion = completion;
  [currentChecker startBonjourCheck];

  // prevent timeout callback operation errors
  LocalNetworkPermissionChecker *capturedChecker = currentChecker;

  dispatch_after(
      dispatch_time(DISPATCH_TIME_NOW, (int64_t)(kGlobalTimeout * NSEC_PER_SEC)),
      dispatch_get_main_queue(), ^{
        // ensure timeout callback only works on the corresponding checker instance
        if (capturedChecker == currentChecker && !capturedChecker.didReturnResult) {
          NSError *timeoutError = [NSError
              errorWithDomain:@"LocalNetworkPermission"
                         code:LocalNetworkPermissionErrorTimeoutFallback
                     userInfo:@{
                       NSLocalizedDescriptionKey : @"Tiemout: Bonjour and TCP checking no resp"
                     }];
          [capturedChecker returnResult:NO error:timeoutError];
        }
      });
}

#pragma mark - Info.plist checking

+ (BOOL)isInfoPlistProperlyConfigured {
  NSDictionary *infoDict = [[NSBundle mainBundle] infoDictionary];

  NSString *desc = infoDict[@"NSLocalNetworkUsageDescription"];
  if (![desc isKindOfClass:[NSString class]] || desc.length == 0) {
    return NO;
  }

  if (@available(iOS 14, *)) {
    NSArray *bonjourServices = infoDict[@"NSBonjourServices"];
    NSString *requiredService1 = @"_check_local_network_permission._tcp";
    NSString *requiredService2 = @"_check_local_network_permission._tcp.";
    if ([bonjourServices isKindOfClass:[NSArray class]]) {
      if ([bonjourServices containsObject:requiredService1]) {
        serviceType = requiredService1;
      } else if ([bonjourServices containsObject:requiredService2]) {
        serviceType = requiredService2;
      } else {
        return NO;
      }
    } else {
      return NO;
    }

  } else {
    NSLog(@"System before iOS 14, local network permissions were always on");
  }

  return YES;
}

#pragma mark - Bonjour checking

- (void)startBonjourCheck {
  self.netService = [[NSNetService alloc] initWithDomain:@"local."
                                                    type:serviceType
                                                    name:@"LocalNetCheckService"
                                                    port:12345];
  self.netService.delegate = self;
  [self.netService publish];

  dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(kBonjourWaitTime * NSEC_PER_SEC)),
                 dispatch_get_main_queue(), ^{
                   if (!self.didReturnResult) {
                     [self.netService stop];
                     // Bonjour no resp, fallback to TCP checking
                     [self fallbackTCPCheck];
                   }
                 });
}

- (void)netServiceDidPublish:(NSNetService *)sender {
  [self.netService stop];
  [self returnResult:YES error:nil];
}

- (void)netService:(NSNetService *)sender
     didNotPublish:(NSDictionary<NSString *, NSNumber *> *)errorDict {
  [self.netService stop];

  // Bonjour publish failed，try TCP checking
  [self fallbackTCPCheck];
}

#pragma mark - TCP checking

- (void)fallbackTCPCheck {
  nw_endpoint_t endpoint = nw_endpoint_create_host("192.168.1.1", "12345");
  nw_parameters_t parameters = nw_parameters_create_secure_tcp(NW_PARAMETERS_DEFAULT_CONFIGURATION,
                                                               NW_PARAMETERS_DEFAULT_CONFIGURATION);
  nw_connection_t connection = nw_connection_create(endpoint, parameters);
  nw_connection_set_queue(connection, dispatch_get_main_queue());

  nw_connection_set_state_changed_handler(
      connection, ^(nw_connection_state_t state, nw_error_t error) {
        if (state == nw_connection_state_ready) {
          nw_connection_cancel(connection);
          [self returnResult:YES error:nil];
        } else if (state == nw_connection_state_failed) {
          nw_connection_cancel(connection);
          NSError *tcpError =
              [NSError errorWithDomain:@"LocalNetworkPermission"
                                  code:LocalNetworkPermissionErrorTCPConnectionFailed
                              userInfo:@{
                                NSLocalizedDescriptionKey :
                                    @"TCP connection failed, LocalNetworking has been denied"
                              }];
          [self returnResult:NO error:tcpError];
        }
      });

  nw_connection_start(connection);
}

#pragma mark - Result

- (void)returnResult:(BOOL)granted error:(NSError *)error {
  if (self.didReturnResult) return;
  self.didReturnResult = YES;

  if (self.completion) {
    self.completion(granted, error);
    self.completion = nil;
  }

  // reset flag
  atomic_store(&isChecking, 0);
  currentChecker = nil;
}

@end
