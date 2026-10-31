#!/usr/bin/env bash
# Gera dist/FicouPronto-Setup-<versao>.exe (requer curl, unzip, sha256sum, makensis).
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"; repo="$(cd "$here/../.." && pwd)"
version="$(grep -oP "AgentVersion = '\K[^']+" "$here/payload/FicouPronto.psm1")"
cache="$here/.cache"; stage="$here/.stage"; dist="$here/dist"
mkdir -p "$cache" "$dist"; rm -rf "$stage"; mkdir -p "$stage/bin" "$stage/agent" "$stage/licenses"
grep -v '^#' "$here/vendor.lock" | while IFS='|' read -r name url sum; do
  [ -z "$name" ] && continue
  if [ ! -f "$cache/$name" ] || ! echo "$sum  $cache/$name" | sha256sum -c --quiet - 2>/dev/null; then
    curl -fsSL -o "$cache/$name.part" "$url"; mv "$cache/$name.part" "$cache/$name"
  fi
  if ! echo "$sum  $cache/$name" | sha256sum -c --quiet -; then echo "SHA-256 diferente para $name: $(sha256sum "$cache/$name" | cut -d' ' -f1)"; exit 1; fi
done
cp "$cache/cloudflared.exe" "$cache/WinSW-x64.exe" "$stage/bin/"
unzip -q -o -j "$cache/mediamtx.zip" mediamtx.exe -d "$stage/bin"; unzip -q -o -j "$cache/mediamtx.zip" LICENSE -d "$stage/licenses" && mv "$stage/licenses/LICENSE" "$stage/licenses/MediaMTX-LICENSE.txt"
unzip -q -o -j "$cache/ffmpeg.zip" '*/bin/ffmpeg.exe' -d "$stage/bin"; unzip -q -o -j "$cache/ffmpeg.zip" '*/LICENSE.txt' -d "$stage/licenses" && mv "$stage/licenses/LICENSE.txt" "$stage/licenses/FFmpeg-GPL-LICENSE.txt"
cp "$here/payload/"*.ps1 "$here/payload/"*.psm1 "$repo/connect/windows/NextVision.Core.psm1" "$stage/agent/"
cp "$here/THIRD_PARTY.txt" "$stage/licenses/"
makensis -V2 -DVERSION="$version" -DSTAGE="$stage" -DOUTFILE="$dist/FicouPronto-Setup-$version.exe" "$here/FicouPronto.nsi"
out="$dist/FicouPronto-Setup-$version.exe"
echo "$out $(stat -c %s "$out") bytes sha256 $(sha256sum "$out" | cut -d' ' -f1)"
