#!/usr/bin/env bash
# Extract 16 kHz mono PCM from each recording's first (AAC) audio track into $OUT (derived copies; originals untouched).
# Usage: FFMPEG=ffmpeg OUT=/tmp/audio ./extract_audio.sh
set -euo pipefail
FFMPEG=${FFMPEG:-ffmpeg}; OUT=${OUT:-./audio}; V=${V:-$(dirname "$0")/../../../public/videos}; mkdir -p "$OUT"
for pair in 01:Jason_cam_01.mov 02:Jason_Cam_02.MOV 03:Jason_cam_03.mov 04:Jason_Cam_04.mov; do
  "$FFMPEG" -y -loglevel error -i "$V/${pair#*:}" -map 0:a:0 -ac 1 -ar 16000 -f s16le "$OUT/cam${pair%%:*}.raw"
done
echo "wrote $OUT/cam0{1..4}.raw — then: python audio_sync_gccphat.py $OUT && python audio_transients.py $OUT"
