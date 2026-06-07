#!/bin/bash
set -e

# This is a shell script used to start the program, can be called on OS startup to auto start the program
# Don't forget to make this file executable with sudo chmod +x begin.sh
# This script now starts from its own directory, so it can be moved without editing the path.
# HINT: If you edited this file in Windows, you may need to run this on the file to fix the windows line endings:  sed -i -e 's/\r$//' begin.sh
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

cd "$SCRIPT_DIR"
npm start
