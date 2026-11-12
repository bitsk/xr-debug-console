#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
"""Compatibility entry: native helper builds are owned by native/CMakeLists.txt."""
from pathlib import Path
import subprocess,sys
root=Path(__file__).resolve().parents[3]
subprocess.run([sys.executable,str(root/"tools/build-native.py"),"--target","nv12-capture-gpu",*sys.argv[1:]],check=True)
