#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
"""Build native helpers through the same CMake entry used by Debian packages."""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess

root = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--output', type=Path, required=True)
parser.add_argument('--target', choices=['all', 'capture', 'nv12-capture', 'nv12-capture-gpu',
                                       'camera-imx', 'vr-timing'], default='all')
parser.add_argument('--toolchain', type=Path)
parser.add_argument('--device-prefix', type=Path)
parser.add_argument('--openvr-include', type=Path)
args = parser.parse_args()
if args.output.exists():
    parser.error('Choose a new output directory')
command = ['cmake', '-S', str(root / 'native'), '-B', str(args.output),
           '-DCMAKE_BUILD_TYPE=Release']
if args.toolchain:
    command.append('-DCMAKE_TOOLCHAIN_FILE=' + str(args.toolchain.resolve()))
if args.device_prefix:
    command.append('-DCMAKE_PREFIX_PATH=' + str(args.device_prefix.resolve()))
if args.openvr_include:
    command.append('-DXR_OPENVR_INCLUDE_DIR=' + str(args.openvr_include.resolve()))
subprocess.run(command, check=True)
subprocess.run(['cmake', '--build', str(args.output), '--target', args.target], check=True)
names = ['capture', 'nv12-capture', 'nv12-capture-gpu', 'camera-imx', 'vr-timing']
files = {name: hashlib.sha256((args.output / name).read_bytes()).hexdigest()
         for name in names if (args.output / name).is_file()}
(args.output / 'build-manifest.json').write_text(json.dumps(
    dict(configure=command, files_sha256=files, hardware_validated=False), indent=2) + '\n')
