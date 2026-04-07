#!/bin/bash
export PATH="/usr/local/bin:$PATH"
cd "$(dirname "$0")/.."
exec npm run dev
