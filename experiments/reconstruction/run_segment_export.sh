#!/usr/bin/env bash
# Re-run segmentation + export for an existing extracted clip (frames/track/plates already present).
set -euo pipefail
cd "$(dirname "$0")"
CLIP=${CLIP:-clip02}; CAMS=${CAMS:-cam1,cam2,cam3,cam4}
.venv/bin/python segmentation/segment_sam2.py --clip $CLIP --cams $CAMS
.venv/bin/python segmentation/export_sprites.py --clip $CLIP --cams $CAMS
