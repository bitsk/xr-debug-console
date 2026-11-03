#!/bin/sh
set -eu
root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
: "${CARGO_HOME:?Set CARGO_HOME to a dedicated writable dependency cache}"
exec cargo fetch --locked --manifest-path "$root/backend/Cargo.toml"
