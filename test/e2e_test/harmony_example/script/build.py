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
HARMONY_EXAMPLE_DIR = os.path.normpath(os.path.join(CUR_DIR, '..'))
ROOT_DIR = os.path.normpath(os.path.join(HARMONY_EXAMPLE_DIR, '..', '..', '..'))

DEFAULT_MODULES = [
    'debug_router',
]

def get_build_type(args):
    build_type = 'debug'
    if args.is_debug is False:
        build_type = 'release'
    return build_type

def run_gn(is_debug, gn_out_dir):
    cmd = f'buildtools/gn/gn gen {gn_out_dir} --args=\'target_os="harmony" is_debug={str(is_debug).lower()} target_cpu="arm64" harmony_sdk_version="default"\''
    print(f'run command {cmd}')
    print(f'cwd is {ROOT_DIR}')
    check_call(cmd, shell=True, cwd=ROOT_DIR)


def run_build_so(output_path, args):
    target = 'debug_router/harmony:harmony'
    cmd = f'buildtools/ninja/ninja -C {output_path} {target}'
    if args.verbose:
        print(f'run command {cmd}')
    check_call(cmd, shell=True, cwd=ROOT_DIR)


def run_cp_so(output_path, args):
    shared_object_cp_map = {
        'libdebugrouter.so': 'debug_router/harmony/debug_router/libs/arm64-v8a/',
    }
    for so, dst in shared_object_cp_map.items():
        src = os.path.join(output_path, so)
        if not os.path.isfile(src):
            print(f'skip cp {so} to {dst} as the {so} file is not built')
            continue
        dst = os.path.join(ROOT_DIR, dst)
        cmd = f'mkdir -p {dst} && cp {src} {dst}'
        if args.verbose:
            print(f'run command {cmd}')
        check_call(cmd, shell=True, cwd=ROOT_DIR)


def get_out_dir(args):
    dir_name = f'harmony_{get_build_type(args)}_arm64'
    out_dir = os.path.join(ROOT_DIR, 'out', dir_name)
    return out_dir


def run_package_har(module_name, module_path, verbose):
    if verbose:
        print(f'===== start run package {module_name} =====')
    cmd = f'hvigorw assembleHar --mode module -p module={module_name}@default -p product=default -p buildMode=debug --no-daemon'
    if verbose:
        print(f'run command {cmd}')
    check_call(cmd, shell=True, cwd=HARMONY_EXAMPLE_DIR)
    # as even hvigor build failed, it still returns value 0, so we need to check har file exist or not
    har_path = os.path.join(HARMONY_EXAMPLE_DIR, module_path, 'build', 'default', 'outputs', 'default', f'{module_name}.har')
    if not os.path.isfile(har_path):
        raise Exception('har file not found, please check your build')


def collect_module_config_list(args):
    import json5
    with open(os.path.join(HARMONY_EXAMPLE_DIR, 'build-profile.json5'), 'r') as f:
        build_profile = json5.load(f)

    module_config_list = build_profile['modules']
    if args.verbose:
        print('module_config_list is' + str(module_config_list))
    return module_config_list

def packDebugrouterHeaderFiles():
    src_path = os.path.join(ROOT_DIR, "debug_router", "common")

    # copy quickjs header files
    dest_path = os.path.join(ROOT_DIR, 'debug_router/harmony/debug_router/src/main/debug_router/include')
    if not os.path.exists(dest_path):
        os.makedirs(dest_path)

    cmds = [
        f"cp -rL {src_path}/*.h ./"
    ]
    cmd = " && ".join(cmds)
    print(f'packDebugrouterHeaderFiles: run command {cmd}')
    check_call(cmd, shell=True, cwd=dest_path)
    pass

def patch_debug_router_version(version, module_path):
    cmd = 'ohpm version {}'.format(version)
    print(f'run command {cmd} in {module_path}')
    check_call(cmd, shell=True, cwd=module_path)
    
    package_file = os.path.join(module_path, "oh-package.json5")
    # print replaced file
    with open(package_file, "r") as f:
        print(f.read())

def run_package_hap(args):
    build_type = get_build_type(args)
    cmd = f"hvigorw assembleApp --mode project -p product=default -p buildMode={build_type} -p skipGn=true --no-daemon"
    if args.verbose:
        print(f'run command {cmd}')
    check_call(cmd, shell=True, cwd=HARMONY_EXAMPLE_DIR)

def main(argv):
    parser = argparse.ArgumentParser()

    parser.add_argument("--is_debug", action="store_true", default=False, help="debug")
    parser.add_argument("--modules", nargs="*", help="list of modules name")
    parser.add_argument("--sync", action="store_true", default=False, help="run lcm sync")
    parser.add_argument("--sync_only", action="store_true", default=False, help="run lcm sync only")
    parser.add_argument("--override_version", type=str, required=False, help="override version")
    parser.add_argument("--verbose", action="store_true", default=False, help="print all commands")
    parser.add_argument("--build_har", action="store_true", default=False, help=" build har")
    parser.add_argument("--build_hap", action="store_true", default=False, help=" build hap")
    args = parser.parse_args()

    print(f'start build with args {args}, environ is {os.environ}')

    if args.modules:
        if len(args.modules) == 1 and args.modules[0].lower() == "default":
            if args.verbose:
                print("Using default module list as '--modules default' was specified.")
            modules = DEFAULT_MODULES
        else:
            modules = args.modules
    else:
        modules = []

    harmony_home = os.getenv('HARMONY_HOME')
    if not harmony_home:
        print('HARMONY_HOME is not set')
        raise Exception('HARMONY_HOME is not set')
    else:
        print('harmony_home is ' + harmony_home)

    gn_out_dir = get_out_dir(args)
    run_gn(args.is_debug, gn_out_dir)
    run_build_so(gn_out_dir, args)
    run_cp_so(gn_out_dir, args)

    if args.build_har and len(modules) > 0:
        commit_hash = os.popen('git rev-parse HEAD').read().strip()
        print('commit hash is ' + commit_hash)

        module_paths = {}
        for module in modules:
            module_config_list = collect_module_config_list(args)
            for module_config in module_config_list:
                if module_config['name'] == module:
                    module_path = module_config['srcPath']
                    module_paths[module] = module_path
                    break
            else:
                raise Exception(f'module {module} not found in build-profile.json5')
            module_full_path = os.path.join(HARMONY_EXAMPLE_DIR, module_path)
            print(f'module {module} full path is {module_full_path}')

            if args.override_version:
                publish_version = args.override_version
                patch_debug_router_version(publish_version, module_full_path)
                print(f'override version to {publish_version}')

            if module == 'debug_router':
                packDebugrouterHeaderFiles()
            run_package_har(module, module_full_path, args.verbose)


    if args.build_hap:
        run_package_hap(args)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
