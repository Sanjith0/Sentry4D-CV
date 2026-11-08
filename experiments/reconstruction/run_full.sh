#!/usr/bin/env bash
# Full-incident real-appearance pipeline (Mac, MPS). ~20-30 min. Outputs are not committed.
set -euo pipefail
cd "$(dirname "$0")"
CLIP=${CLIP:-clip02}; T0=${T0:-4.2}; T1=${T1:-25.2}; FPS=${FPS:-15}; CAMS=${CAMS:-cam1,cam2,cam3,cam4}
PY=.venv/bin/python
echo "== extract frames"; $PY preprocess/extract_clip.py --clip $CLIP --t0 $T0 --t1 $T1 --fps $FPS --cams $CAMS
echo "== export track";   (cd ../.. && node experiments/reconstruction/preprocess/export_track.mjs --clip $CLIP --t0 $T0 --t1 $T1 --fps $FPS --cams $CAMS)
echo "== segment";        $PY segmentation/segment_sam2.py --clip $CLIP --cams $CAMS
echo "== plates";         $PY segmentation/background_plate.py --cams $CAMS
echo "== export";         $PY segmentation/export_sprites.py --clip $CLIP --cams $CAMS
echo "== done"
