#!/usr/bin/env bash
# Assemble the public site from an allowlist. Only what is copied here is ever published,
# so drafts (index-old.html), function source and config can never be served by accident.
set -euo pipefail
cd "$(dirname "$0")/.."
rm -rf _site && mkdir -p _site/.well-known
cp index.html terms.html privacy.html about-jona.html explainer.mp4 robots.txt _headers _site/
cp -R images _site/images
cp .well-known/security.txt _site/.well-known/
echo "built _site: $(find _site -type f | wc -l | tr -d ' ') files, $(du -sh _site | cut -f1)"
