#!/usr/bin/env bash
set -uo pipefail

LOG_FILE="/tmp/power_change.log"
echo "$(date): Power source changed to $1" >>"$LOG_FILE"

case "$1" in
ac)
  sudo powerprofilesctl set performance 2>&1 | tee -a "$LOG_FILE" >/dev/null
  status=${PIPESTATUS[0]}
  echo "status: $status" >>"$LOG_FILE"
  ;;
battery)
  sudo powerprofilesctl set power-saver 2>&1 | tee -a "$LOG_FILE" >/dev/null
  status=${PIPESTATUS[0]}
  echo "status: $status" >>"$LOG_FILE"
  ;;
*)
  echo "$(date): Invalid argument: $1" >>"$LOG_FILE"
  echo "Usage: $0 {ac|battery}" >>"$LOG_FILE"
  exit 1
  ;;
esac
