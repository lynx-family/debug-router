#!/usr/bin/env python3
# -*- coding: UTF-8 -*-
# Copyright 2025 The Lynx Authors. All rights reserved.
# Licensed under the Apache License Version 2.0 that can be found in the
# LICENSE file in the root directory of this source tree.

import argparse
import os
import sys
from subprocess import check_call

CUR_DIR = os.path.dirname(os.path.abspath(__file__))
HARMONY_DIR = os.path.normpath(os.path.join(CUR_DIR, '..'))

def get_build_type(args):
    build_type = 'debug'
    if args.is_debug is False:
        build_type = 'release'
    return build_type

def main(argv):
    parser = argparse.ArgumentParser()
    parser.add_argument("--is_debug", action="store_true", default=False, help="debug")
    parser.add_argument("--modules", nargs="*", help="list of modules name")
    parser.add_argument("--sync", action="store_true", default=False, help="run lcm sync")
    parser.add_argument("--verbose", action="store_true", default=False, help="print all commands")
    parser.add_argument("--build_hap", action="store_true", default=False, help=" build hap")
    args = parser.parse_args()

    # 先执行debug_router的构建(debug)
    cmds = [
        f"python3 ../../../debug_router/harmony/script/build.py --is_debug --build_har --verbose"
    ]
    cmd = " && ".join(cmds)
    print(f'run command {cmd}')
    check_call(cmd, shell=True, cwd=HARMONY_DIR)

    if args.build_hap:
        build_type = get_build_type(args)
        cmd = f"hvigorw assembleApp --mode project -p product=default -p buildMode={build_type} -p skipGn=true --no-daemon"
        if args.verbose:
            print(f'run command {cmd}')
        check_call(cmd, shell=True, cwd=HARMONY_DIR)

    return 0

if __name__ == "__main__":
    sys.exit(main(sys.argv))
