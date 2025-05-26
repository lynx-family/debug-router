// Copyright 2023 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

#import "DebugRouterViewController.h"
#import "LocalNetworkPermissionChecker.h"

@interface DebugRouterViewController ()
@property(nonatomic, strong) UILabel *statusLabel;
@property(nonatomic, strong) UIButton *checkButton;
@end

@implementation DebugRouterViewController

- (void)viewDidLoad {
  [super viewDidLoad];
  self.view.backgroundColor = [UIColor whiteColor];

  [self setupUI];
}

- (void)setupUI {
  self.statusLabel =
      [[UILabel alloc] initWithFrame:CGRectMake(40, 150, self.view.frame.size.width - 80, 70)];
  self.statusLabel.textAlignment = NSTextAlignmentCenter;
  self.statusLabel.text = @"N/A";
  self.statusLabel.numberOfLines = 0;
  self.statusLabel.adjustsFontSizeToFitWidth = NO;
  self.statusLabel.lineBreakMode = NSLineBreakByWordWrapping;
  [self.view addSubview:self.statusLabel];

  self.checkButton = [UIButton buttonWithType:UIButtonTypeSystem];
  self.checkButton.frame = CGRectMake(100, 250, self.view.frame.size.width - 200, 50);
  [self.checkButton setTitle:@"Check Local Network" forState:UIControlStateNormal];
  [self.checkButton addTarget:self
                       action:@selector(checkPermission)
             forControlEvents:UIControlEventTouchUpInside];
  [self.view addSubview:self.checkButton];
}

- (void)checkPermission {
  self.statusLabel.text = @"Checking...";

  [LocalNetworkPermissionChecker
      checkPermissionWithCompletion:^(BOOL granted, NSError *_Nullable error) {
        dispatch_async(dispatch_get_main_queue(), ^{
          if (error.code == LocalNetworkPermissionNotDetermined) {
            self.statusLabel.text = @"❓ Not Determined";
            self.statusLabel.textColor = [UIColor orangeColor];
            return;
          }
          if (granted) {
            self.statusLabel.text = @"✅ Local Network enabled";
            self.statusLabel.textColor = [UIColor systemGreenColor];
          } else {
            NSString *errorReason = error.userInfo[NSLocalizedDescriptionKey];
            self.statusLabel.text =
                [NSString stringWithFormat:@"❌ Local Network denied, reason: %@", errorReason];
            self.statusLabel.textColor = [UIColor systemRedColor];
          }
        });
      }];
}

- (void)didReceiveMemoryWarning {
  [super didReceiveMemoryWarning];
  // Dispose of any resources that can be recreated.
}

@end
