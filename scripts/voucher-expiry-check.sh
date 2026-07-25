#!/bin/bash
# Voucher Expiry Check — finds expired vouchers and creates a PR to mark them
set -euo pipefail

VOUCHER_DIR="src/content/docs/vouchers"
REPORT="/tmp/voucher-changes.md"
TODAY=$(date -u +%s)
EXPIRED_COUNT=0
CHANGES=""

# Month name to number mapping
declare -A MONTHS=(
  [January]=01 [February]=02 [March]=03 [April]=04
  [May]=05 [June]=06 [July]=07 [August]=08
  [September]=09 [October]=10 [November]=11 [December]=12
  [Jan]=01 [Feb]=02 [Mar]=03 [Apr]=04
  [Jun]=06 [Jul]=07 [Aug]=08 [Sep]=09 [Oct]=10 [Nov]=11 [Dec]=12
)

# Parse a date string to epoch seconds
parse_date() {
  local date_str="$1"
  local month day year

  # Format: "Month DD, YYYY" or "Month DDth, YYYY"
  if [[ "$date_str" =~ ([A-Za-z]+)[[:space:]]+([0-9]{1,2})(st|nd|rd|th)?,?[[:space:]]+([0-9]{4}) ]]; then
    month="${BASH_REMATCH[1]}"
    day="${BASH_REMATCH[2]}"
    year="${BASH_REMATCH[4]}"
  # Format: "Mon DD–DD YYYY" (take the last day in range)
  elif [[ "$date_str" =~ ([A-Za-z]+)[[:space:]]+[0-9]{1,2}–([0-9]{1,2})[[:space:]]+([0-9]{4}) ]]; then
    month="${BASH_REMATCH[1]}"
    day="${BASH_REMATCH[2]}"
    year="${BASH_REMATCH[3]}"
  # Format: "Mon YYYY" (use last day of month)
  elif [[ "$date_str" =~ ([A-Za-z]+)[[:space:]]+([0-9]{4}) ]]; then
    month="${BASH_REMATCH[1]}"
    year="${BASH_REMATCH[2]}"
    # Use last day of month
    case "${month,,}" in
      jan|january) day=31 ;;
      feb|february) day=28 ;;
      mar|march) day=31 ;;
      apr|april) day=30 ;;
      may) day=31 ;;
      jun|june) day=30 ;;
      jul|july) day=31 ;;
      aug|august) day=31 ;;
      sep|september) day=30 ;;
      oct|october) day=31 ;;
      nov|november) day=30 ;;
      dec|december) day=31 ;;
      *) day=28 ;;
    esac
  else
    echo ""
    return
  fi

  # Normalize month name to number
  local month_num="${MONTHS[$month]:-}"
  if [ -z "$month_num" ]; then
    echo ""
    return
  fi

  # Pad day
  printf -v day "%02d" "$day"

  echo "${year}-${month_num}-${day}"
}

# Extract all dates from a file, find the latest one
find_latest_date() {
  local file="$1"
  local latest=""

  # Full month names: "August 5, 2026" or "May 31st, 2026"
  while IFS= read -r match; do
    [ -z "$match" ] && continue
    local parsed
    parsed=$(parse_date "$match")
    [ -z "$parsed" ] && continue
    if [ -z "$latest" ] || [[ "$parsed" > "$latest" ]]; then
      latest="$parsed"
    fi
  done < <(grep -oP '(?:January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2}(?:st|nd|rd|th)?,?\s+\d{4}' "$file" 2>/dev/null || true)

  # Abbreviated with range: "Jul 27–31 2026"
  while IFS= read -r match; do
    [ -z "$match" ] && continue
    local parsed
    parsed=$(parse_date "$match")
    [ -z "$parsed" ] && continue
    if [ -z "$latest" ] || [[ "$parsed" > "$latest" ]]; then
      latest="$parsed"
    fi
  done < <(grep -oP '(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2}–\d{1,2}\s+\d{4}' "$file" 2>/dev/null || true)

  echo "$latest"
}

echo "Scanning voucher files..."

for file in "$VOUCHER_DIR"/*.mdx; do
  [ -f "$file" ] || continue
  filename=$(basename "$file")

  # Skip betaexams (index page, not a real voucher)
  [ "$filename" = "betaexams.mdx" ] && continue

  latest_date=$(find_latest_date "$file")

  if [ -z "$latest_date" ]; then
    echo "  SKIP $filename (no dates found)"
    continue
  fi

  latest_epoch=$(date -d "$latest_date" +%s 2>/dev/null || echo "0")
  today_epoch=$(date -d "$(date -u +%Y-%m-%d)" +%s)

  if [ "$latest_epoch" -lt "$today_epoch" ]; then
    echo "  EXPIRED $filename (expired: $latest_date)"

    # Get current title from frontmatter
    current_title=$(grep -m1 '^title:' "$file" | sed 's/^title:[[:space:]]*//' | sed 's/^"//' | sed 's/"$//')

    # Check if already marked as expired
    if echo "$current_title" | grep -qi "expired"; then
      echo "    Already marked as expired, skipping"
      continue
    fi

    # Mark title as expired
    new_title="${current_title} (Expired)"
    sed -i "0,/^title:/{s|^title:.*|title: \"${new_title}\"|}" "$file"

    CHANGES="${CHANGES}| \`${filename}\` | ${latest_date} | Title updated |\n"
    EXPIRED_COUNT=$((EXPIRED_COUNT + 1))
  else
    echo "  OK   $filename (latest: $latest_date)"
  fi
done

if [ "$EXPIRED_COUNT" -gt 0 ]; then
  echo "# Expired Vouchers" > "$REPORT"
  echo "" >> "$REPORT"
  echo "Found $EXPIRED_COUNT expired voucher(s):" >> "$REPORT"
  echo "" >> "$REPORT"
  echo "| File | Expired Date | Action |" >> "$REPORT"
  echo "|------|-------------|--------|" >> "$REPORT"
  echo -e "$CHANGES" >> "$REPORT"
  echo "" >> "$REPORT"
  echo "Titles have been updated to include \"(Expired)\"." >> "$REPORT"

  echo "expired=true" >> "${GITHUB_OUTPUT:-/dev/null}"
  echo "::warning::Found $EXPIRED_COUNT expired voucher(s)"
else
  echo "No expired vouchers found"
  echo "expired=false" >> "${GITHUB_OUTPUT:-/dev/null}"
fi
