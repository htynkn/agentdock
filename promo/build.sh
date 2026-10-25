#!/usr/bin/env bash
# AgentDock 宣传片 · 一次成型
# ---------------------------------------------------------------------------
#   1. render/frames/*.png  +  render/audio.wav   （由 capture.mjs / audio.py 产生）
#   2. 音轨响度归一 → render/audio_norm.wav
#   3. out/agentdock-promo-1440p.mp4   2560x1440 h264 + AAC
#   4. out/agentdock-promo-1080p.mp4   1920x1080 h264 + AAC
#   5. out/agentdock-promo-poster.png  1920x1080 海报帧
#   6. out/agentdock-promo.gif         480px / 10fps 预览
#
#   ./build.sh              # 全流程（不重新渲染）
#   ./build.sh --capture    # 先渲染 4K 帧序列 + 合成音轨，再出片
set -euo pipefail
cd "$(dirname "$0")"

FPS=30
FRAMES_DIR=render/frames
OUT=out

if [[ "${1:-}" == "--capture" ]]; then
  node capture.mjs --fps "$FPS" --dpr 2 --out "$FRAMES_DIR"
  uv run --with numpy python audio.py
fi

[[ -d "$FRAMES_DIR" ]] || { echo "缺少 $FRAMES_DIR，先跑 ./build.sh --capture"; exit 1; }
[[ -f render/audio.wav ]] || { echo "缺少 render/audio.wav，先跑 audio.py"; exit 1; }
mkdir -p "$OUT"

# --- 响度归一（单遍 loudnorm 已经足够，避免二次解析） ---
ffmpeg -y -loglevel error -i render/audio.wav \
  -af "loudnorm=I=-16:TP=-1.5:LRA=11" -ar 48000 -ac 2 render/audio_norm.wav
echo "✓ 音轨归一 → render/audio_norm.wav"

COMMON_VIDEO=(-framerate "$FPS" -i "$FRAMES_DIR/frame_%05d.png")
COMMON_AUDIO=(-i render/audio_norm.wav)
COMMON_TAIL=(-c:a aac -shortest -movflags +faststart)

# --- 1440p 母版 ---
ffmpeg -y -loglevel error "${COMMON_VIDEO[@]}" "${COMMON_AUDIO[@]}" \
  -vf "scale=2560:1440:flags=lanczos" \
  -c:v libx264 -preset slow -crf 18 -pix_fmt yuv420p -profile:v high -level 5.1 \
  -b:a 256k "${COMMON_TAIL[@]}" "$OUT/agentdock-promo-1440p.mp4"
echo "✓ $OUT/agentdock-promo-1440p.mp4"

# --- 1080p 分享版 ---
ffmpeg -y -loglevel error "${COMMON_VIDEO[@]}" "${COMMON_AUDIO[@]}" \
  -vf "scale=1920:1080:flags=lanczos" \
  -c:v libx264 -preset slow -crf 19 -pix_fmt yuv420p -profile:v high -level 4.2 \
  -b:a 192k "${COMMON_TAIL[@]}" "$OUT/agentdock-promo-1080p.mp4"
echo "✓ $OUT/agentdock-promo-1080p.mp4"

# --- 海报帧（KEY3 那一段：整机 + 终端 + 标注都在） ---
POSTER_T=24.2
POSTER_FRAME=$(printf "%05d" "$(python3 -c "print(round($POSTER_T*$FPS))")")
ffmpeg -y -loglevel error -i "$FRAMES_DIR/frame_$POSTER_FRAME.png" \
  -vf "scale=1920:1080:flags=lanczos" "$OUT/agentdock-promo-poster.png"
echo "✓ $OUT/agentdock-promo-poster.png"

# --- GIF（两遍调色板，480px / 10fps） ---
GIF_FILTER="fps=10,scale=480:-1:flags=lanczos"
ffmpeg -y -loglevel error -i "$OUT/agentdock-promo-1080p.mp4" \
  -vf "$GIF_FILTER,palettegen=stats_mode=diff" /tmp/ad_pal.png
ffmpeg -y -loglevel error -i "$OUT/agentdock-promo-1080p.mp4" -i /tmp/ad_pal.png \
  -lavfi "$GIF_FILTER [x]; [x][1:v] paletteuse=dither=bayer:bayer_scale=3" \
  -loop 0 "$OUT/agentdock-promo.gif"
echo "✓ $OUT/agentdock-promo.gif"

ls -lh "$OUT"
