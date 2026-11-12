#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
"""Select the exact upstream plugins needed by the packaged WebRTC path."""
import argparse,hashlib,json,subprocess,tarfile
from pathlib import Path
p=argparse.ArgumentParser(description=__doc__);p.add_argument('--package',type=Path,required=True);p.add_argument('--output',type=Path,required=True);a=p.parse_args();root=Path(__file__).resolve().parents[1];lock=json.loads((root/'dependencies/gstreamer-webrtc/source.lock.json').read_text())
if a.package.stat().st_size!=lock['bytes'] or hashlib.sha256(a.package.read_bytes()).hexdigest()!=lock['sha256']:raise ValueError('GStreamer upstream package checksum mismatch')
process=subprocess.Popen(['dpkg-deb','--fsys-tarfile',str(a.package)],stdout=subprocess.PIPE);seen=set()
try:
 with tarfile.open(fileobj=process.stdout,mode='r|') as archive:
  for member in archive:
   name=member.name.removeprefix('./')
   if name not in lock['files']:continue
   if not member.isfile():raise ValueError('Expected a regular upstream plugin file')
   content=archive.extractfile(member).read();entry=lock['files'][name]
   if hashlib.sha256(content).hexdigest()!=entry['sha256']:raise ValueError('Upstream plugin digest mismatch')
   target=a.output/entry['destination'];target.parent.mkdir(parents=True,exist_ok=True);target.write_bytes(content);target.chmod(member.mode&0o755);seen.add(name)
 if process.wait()!=0:raise ValueError('Cannot read upstream GStreamer package')
finally:
 process.stdout.close()
 if process.poll() is None:process.kill();process.wait()
if seen!=set(lock['files']):raise ValueError('Missing pinned upstream plugin payload')
