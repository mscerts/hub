#!/bin/bash
# Sitemap Validator — checks all URLs in the sitemap return 200
set -euo pipefail

SITEMAP_INDEX="dist/sitemap-index.xml"
REPORT="/tmp/sitemap-report.md"
TEMP_DIR=$(mktemp -d)
URLS_FILE="$TEMP_DIR/urls.txt"
ISSUES=0

cleanup() { rm -rf "$TEMP_DIR"; }
trap cleanup EXIT

if [ ! -f "$SITEMAP_INDEX" ]; then
  echo "Sitemap not found at $SITEMAP_INDEX — did you run pnpm build?"
  exit 1
fi

# Extract URLs from sitemap index → individual sitemaps → loc entries
echo "Extracting URLs from sitemap..."

# Get individual sitemap URLs from the index
SITEMAPS=$(grep -oP '<loc>\K[^<]+' "$SITEMAP_INDEX" || true)

if [ -z "$SITEMAPS" ]; then
  # Maybe it's a flat sitemap, not an index
  grep -oP '<loc>\K[^<]+' "$SITEMAP_INDEX" > "$URLS_FILE"
else
  for sitemap_url in $SITEMAPS; do
    # Download each sub-sitemap to temp
    filename="$TEMP_DIR/$(echo "$sitemap_url" | md5sum | cut -d' ' -f1).xml"
    curl -sL "$sitemap_url" -o "$filename" 2>/dev/null || true
    grep -oP '<loc>\K[^<]+' "$filename" >> "$URLS_FILE" 2>/dev/null || true
  done
fi

TOTAL=$(wc -l < "$URLS_FILE")
echo "Found $TOTAL URLs to check"

# Check each URL
echo "# Sitemap Validator Report" > "$REPORT"
echo "" >> "$REPORT"
echo "Checked: $(date -u +%Y-%m-%d)" >> "$REPORT"
echo "Total URLs: $TOTAL" >> "$REPORT"
echo "" >> "$REPORT"

BAD_URLS=""

while IFS= read -r url; do
  [ -z "$url" ] && continue
  HTTP_CODE=$(curl -sL -o /dev/null -w "%{http_code}" --max-time 15 "$url" 2>/dev/null || echo "000")
  if [ "$HTTP_CODE" -ge 400 ] || [ "$HTTP_CODE" = "000" ]; then
    BAD_URLS="${BAD_URLS}| $url | $HTTP_CODE |\n"
    ISSUES=$((ISSUES + 1))
    echo "  FAIL [$HTTP_CODE] $url"
  else
    echo "  OK   [$HTTP_CODE] $url"
  fi
done < "$URLS_FILE"

if [ "$ISSUES" -gt 0 ]; then
  echo "## Broken URLs" >> "$REPORT"
  echo "" >> "$REPORT"
  echo "| URL | Status |" >> "$REPORT"
  echo "|-----|--------|" >> "$REPORT"
  echo -e "$BAD_URLS" >> "$REPORT"
  echo "" >> "$REPORT"
  echo "**$ISSUES URL(s) returned errors.**" >> "$REPORT"

  echo "has_issues=true" >> "${GITHUB_OUTPUT:-/dev/null}"
  echo "::warning::Found $ISSUES broken URLs in sitemap"
else
  echo "All $TOTAL URLs OK" >> "$REPORT"
  echo "has_issues=false" >> "${GITHUB_OUTPUT:-/dev/null}"
fi
