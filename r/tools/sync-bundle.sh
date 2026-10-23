#!/bin/sh
# Copy the built dashboards bundle into this package (scripts/build.mjs does the same on every build).
set -e
here="$(cd "$(dirname "$0")/.." && pwd)"
cp "$here/../dist/canvasxpress-dashboards.umd.js" "$here/inst/htmlwidgets/lib/canvasxpress-dashboards/"
echo "synced bundle into r/inst/htmlwidgets/lib/canvasxpress-dashboards/"
