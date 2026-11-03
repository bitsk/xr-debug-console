#!/usr/bin/env python3
"""Embed the generated SPIR-V module for the native NV12 conversion helper."""
import struct,sys
from pathlib import Path
data=Path(sys.argv[1]).read_bytes()
if len(data)%4 or data[:4]!=bytes.fromhex('03022307'):
    raise ValueError('Invalid SPIR-V build output')
words=struct.unpack('<'+'I'*(len(data)//4),data)
Path(sys.argv[2]).write_text('static const uint32_t nv12_shader[] = {\n'+',\n'.join('0x%08x'%w for w in words)+'\n};\n')
