#!/bin/bash
set -euo pipefail

SITEMAP_INDEX="${SITEMAP_INDEX:-dist/sitemap-index.xml}"
REPORT="${REPORT:-/tmp/sitemap-report.md}"
CHECK_ORIGIN="${CHECK_ORIGIN:-}"
GITHUB_OUTPUT="${GITHUB_OUTPUT:-/dev/null}"
TEMP_DIR=$(mktemp -d)
URLS_FILE="$TEMP_DIR/urls.txt"
ISSUES=0

cleanup() { rm -rf "$TEMP_DIR"; }
trap cleanup EXIT
: > "$URLS_FILE"

write_output() { printf '%s=%s\n' "$1" "$2" >> "$GITHUB_OUTPUT"; }
local_url() {
  local url="$1" remainder
  if [[ -z "$CHECK_ORIGIN" ]]; then
    printf '%s\n' "$url"
    return
  fi
  remainder=${url#*://}
  printf '%s/%s\n' "${CHECK_ORIGIN%/}" "${remainder#*/}"
}
fetch() {
  local url="$1"
  shift
  curl --fail --silent --show-error --location \
    --connect-timeout 5 --max-time 15 --retry 2 "$url" "$@"
}
extract_locs() {
  python3 - "$1" <<'PYEOF'
import sys
import xml.etree.ElementTree as ET

root = ET.parse(sys.argv[1]).getroot()
for element in root.iter():
    if element.tag.rsplit('}', 1)[-1] == 'loc' and element.text:
        print(element.text.strip())
PYEOF
}
is_index() {
  python3 - "$1" <<'PYEOF'
import sys
import xml.etree.ElementTree as ET

root = ET.parse(sys.argv[1]).getroot()
raise SystemExit(0 if root.tag.rsplit('}', 1)[-1] == 'sitemapindex' else 1)
PYEOF
}
fail_validation() {
  printf '# Sitemap Validator Report\n\n%s\n' "$1" > "$REPORT"
  write_output has_issues true
  write_output validation_failed true
  printf 'ERROR: %s\n' "$1" >&2
  exit 1
}

[[ -f "$SITEMAP_INDEX" ]] || fail_validation "Sitemap not found at $SITEMAP_INDEX."

if is_index "$SITEMAP_INDEX"; then
  extract_locs "$SITEMAP_INDEX" > "$TEMP_DIR/sitemaps.txt" || fail_validation "Sitemap index is malformed."
  [[ -s "$TEMP_DIR/sitemaps.txt" ]] || fail_validation "Sitemap index contains no child sitemaps."
  sitemap_number=0
  while IFS= read -r sitemap_url; do
    sitemap_number=$((sitemap_number + 1))
    file="$TEMP_DIR/sitemap-$sitemap_number.xml"
    request_url=$(local_url "$sitemap_url")
    fetch "$request_url" --output "$file" || fail_validation "Failed to fetch child sitemap: $request_url"
    extract_locs "$file" >> "$URLS_FILE" || fail_validation "Child sitemap is malformed: $request_url"
  done < "$TEMP_DIR/sitemaps.txt"
else
  extract_locs "$SITEMAP_INDEX" > "$URLS_FILE" || fail_validation "Sitemap is malformed."
fi

sort -u -o "$URLS_FILE" "$URLS_FILE"
TOTAL=$(wc -l < "$URLS_FILE")
((TOTAL > 0)) || fail_validation "Sitemap contains zero page URLs."

printf '# Sitemap Validator Report\n\nChecked: %s\nTotal URLs: %s\n\n' "$(date -u +%Y-%m-%d)" "$TOTAL" > "$REPORT"
BAD_URLS=""
while IFS= read -r url; do
  request_url=$(local_url "$url")
  set +e
  HTTP_CODE=$(curl --silent --show-error --location --output /dev/null --write-out '%{http_code}' \
    --connect-timeout 5 --max-time 15 --retry 2 "$request_url")
  CURL_EXIT=$?
  set -e
  if ((CURL_EXIT != 0)) || [[ ! "$HTTP_CODE" =~ ^2[0-9]{2}$ ]]; then
    BAD_URLS+="| $url | ${HTTP_CODE:-000} |"$'\n'
    ISSUES=$((ISSUES + 1))
  fi
done < "$URLS_FILE"

if ((ISSUES > 0)); then
  printf '## Broken URLs\n\n| URL | Status |\n|-----|--------|\n%s\n**%s URL(s) returned errors.**\n' "$BAD_URLS" "$ISSUES" >> "$REPORT"
  write_output has_issues true
  write_output validation_failed false
  exit 1
fi

printf 'All %s URLs OK\n' "$TOTAL" >> "$REPORT"
write_output has_issues false
write_output validation_failed false
