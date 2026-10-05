#!/usr/bin/env sh
# Build everything on a connected machine and produce a single archive to carry across
# the air gap. On the offline host:
#
#   tar xf sakshi-offline.tar && cd sakshi-offline
#   docker load -i images.tar
#   docker compose run --rm setup && docker compose up -d
#
set -eu
cd "$(dirname "$0")/.."
OUT=sakshi-offline
rm -rf "$OUT" && mkdir -p "$OUT"

docker compose build
docker save -o "$OUT/images.tar" sakshi-web:latest sakshi-validator:latest sakshi-wm:latest
cp docker-compose.yml "$OUT/"
mkdir -p "$OUT/deploy" && cp deploy/Dockerfile "$OUT/deploy/"

# Optional non-Docker path: Python wheels and the npm cache for a bare-metal install.
if [ "${WITH_SOURCES:-0}" = "1" ]; then
  git archive --format=tar HEAD | tar -x -C "$OUT" --one-top-level=source
  python -m pip download -r wm-engine/requirements.txt -d "$OUT/wheelhouse"
  npm ci --cache "$OUT/npm-cache" --prefer-online --no-audit --no-fund >/dev/null
fi

tar cf sakshi-offline.tar "$OUT"
sha256sum sakshi-offline.tar | tee sakshi-offline.tar.sha256
echo "Carry sakshi-offline.tar (and its .sha256) across the air gap."
