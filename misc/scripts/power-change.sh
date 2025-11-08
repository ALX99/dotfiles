#!/usr/bin/env bash
set -uo pipefail

LOG_FILE="/tmp/power_change.log"
echo "$(date): Power source changed to $1" >>"$LOG_FILE"

case "$1" in
ac)
  sudo powerprofilesctl set performance >>"$LOG_FILE" 2>&1
  echo "status: $?" >>"$LOG_FILE"
  ;;
battery)
  sudo powerprofilesctl set power-saver >>"$LOG_FILE" 2>&1
  echo "status: $?" >>"$LOG_FILE"
  ;;
*)
  echo "$(date): Invalid argument: $1" >>"$LOG_FILE"
  echo "Usage: $0 {ac|battery}" >>"$LOG_FILE"
  exit 1
  ;;
esac
