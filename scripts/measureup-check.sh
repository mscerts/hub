#!/bin/bash
set -euo pipefail

BASE_URL="https://www.measureup.com/microsoft.html"
BASELINE_FILE="src/data_files/measureup-products.json"
TEMP_DIR="/tmp/measureup-scan"
ALL_PRODUCTS_FILE="$TEMP_DIR/all-products.jsonl"
REPORT_FILE="/tmp/measureup-report.md"
ERROR_FILE="/tmp/measureup-error.md"

MIN_PRODUCTS=100
MAX_NEW_PCT=50

mkdir -p "$TEMP_DIR"
> "$ALL_PRODUCTS_FILE"

echo "=== MeasureUp Monitor ==="
echo "Started: $(date -u +%Y-%m-%dT%H:%M:%SZ)"

# --- Step 1: Fetch page 1, detect total pages ---
echo "Fetching page 1..."
curl -sL --max-time 20 --retry 3 --retry-delay 5 "$BASE_URL" -o "$TEMP_DIR/page-1.html" 2>/dev/null

if [ ! -s "$TEMP_DIR/page-1.html" ]; then
  echo "ERROR: Failed to fetch page 1"
  echo "Failed to fetch MeasureUp page 1. Site may be down or blocking requests." > "$ERROR_FILE"
  echo "extraction_failed=true" >> "$GITHUB_OUTPUT"
  exit 1
fi

TOTAL=$(grep -oP 'toolbar-number">\K\d+' "$TEMP_DIR/page-1.html" | sed -n '3p')

if [ -z "$TOTAL" ] || [ "$TOTAL" -lt "$MIN_PRODUCTS" ]; then
  echo "ERROR: Total=$TOTAL (expected >$MIN_PRODUCTS)."
  echo "MeasureUp extraction failed. Got total=$TOTAL (expected >$MIN_PRODUCTS)." > "$ERROR_FILE"
  echo "extraction_failed=true" >> "$GITHUB_OUTPUT"
  exit 1
fi

PAGES=$(( (TOTAL + 11) / 12 ))
echo "Found $TOTAL products across $PAGES pages"

# --- Step 2: Extract products from all pages using Python ---
extract_page() {
  local page_file="$1"
  python3 -c "
import re, json

with open('$page_file') as f:
    html = f.read()

match = re.search(r'var dl4Objects = (\[.*?\]);', html, re.DOTALL)
if not match:
    exit(0)

try:
    data = json.loads(match.group(1))
    items = data[0]['ecommerce']['items']
    for item in items:
        name = item.get('item_name', '')
        item_id = item.get('item_id', '')
        category = item.get('item_category3', '')
        
        ptype = 'unknown'
        if 'Assessment' in category: ptype = 'assessment'
        elif 'Practice Test' in category: ptype = 'practice-test'
        elif 'CertKit' in category: ptype = 'certkit'
        elif 'Bundle' in category: ptype = 'bundle'
        
        # Skip retired products
        if 'Retired' in name or 'retired' in name:
            continue
        
        match = re.search(r'([A-Z]{2,3}-\d+)', name)
        exam_code = match.group(1) if match else ''
        
        slug = re.sub(r'[^a-z0-9]+', '-', name.lower()).strip('-')
        url = f'https://www.measureup.com/{slug}.html'
        
        print(json.dumps({'name': name, 'id': item_id, 'examCode': exam_code, 'type': ptype, 'url': url}))
except:
    pass
"
}

echo "Extracting products from page 1..."
extract_page "$TEMP_DIR/page-1.html" >> "$ALL_PRODUCTS_FILE"

for p in $(seq 2 $PAGES); do
  echo "Fetching page $p/$PAGES..."
  sleep 2
  
  curl -sL --max-time 20 --retry 3 --retry-delay 5 "${BASE_URL}?p=$p" -o "$TEMP_DIR/page-$p.html" 2>/dev/null
  
  if [ ! -s "$TEMP_DIR/page-$p.html" ]; then
    echo "WARNING: Failed to fetch page $p, skipping"
    continue
  fi
  
  extract_page "$TEMP_DIR/page-$p.html" >> "$ALL_PRODUCTS_FILE"
done

# Deduplicate by ID
sort -u "$ALL_PRODUCTS_FILE" -o "$ALL_PRODUCTS_FILE"
EXTRACTED_COUNT=$(wc -l < "$ALL_PRODUCTS_FILE")

echo "Extracted $EXTRACTED_COUNT unique products"

if [ "$EXTRACTED_COUNT" -lt "$MIN_PRODUCTS" ]; then
  echo "ERROR: Only $EXTRACTED_COUNT products (expected >$MIN_PRODUCTS)."
  echo "MeasureUp extraction partially failed. Got $EXTRACTED_COUNT products (expected >$MIN_PRODUCTS)." > "$ERROR_FILE"
  echo "extraction_failed=true" >> "$GITHUB_OUTPUT"
  exit 1
fi

# --- Step 3: Compare against baseline ---
if [ ! -f "$BASELINE_FILE" ] || [ ! -s "$BASELINE_FILE" ]; then
  echo "No baseline found. Creating initial baseline..."
  
  python3 -c "
import json
products = []
with open('$ALL_PRODUCTS_FILE') as f:
    for line in f:
        line = line.strip()
        if line:
            products.append(json.loads(line))
baseline = {
    'lastChecked': '$(date -u +%Y-%m-%dT%H:%M:%SZ)',
    'totalProducts': len(products),
    'products': products
}
with open('$BASELINE_FILE', 'w') as f:
    json.dump(baseline, f, indent=2)
print(f'Baseline created with {len(products)} products')
"
  
  echo "new_products=false" >> "$GITHUB_OUTPUT"
  echo "extraction_failed=false" >> "$GITHUB_OUTPUT"
  exit 0
fi

# --- Step 4: Compare and generate report ---
echo "Comparing against baseline..."

BASELINE_FILE="$BASELINE_FILE" ALL_PRODUCTS_FILE="$ALL_PRODUCTS_FILE" REPORT_FILE="$REPORT_FILE" ERROR_FILE="$ERROR_FILE" MAX_NEW_PCT="$MAX_NEW_PCT" python3 << 'PYEOF'
import json, os, datetime

baseline_file = os.environ["BASELINE_FILE"]
extracted_file = os.environ["ALL_PRODUCTS_FILE"]
report_file = os.environ["REPORT_FILE"]
error_file = os.environ["ERROR_FILE"]
github_output = os.environ.get("GITHUB_OUTPUT", "/tmp/github-output")
max_new_pct = int(os.environ["MAX_NEW_PCT"])

with open(baseline_file) as f:
    baseline = json.load(f)

baseline_ids = {p["id"] for p in baseline["products"]}

extracted = []
with open(extracted_file) as f:
    for line in f:
        line = line.strip()
        if line:
            extracted.append(json.loads(line))

extracted_ids = {p["id"] for p in extracted}
new_products = [p for p in extracted if p["id"] not in baseline_ids]
new_count = len(new_products)
extracted_count = len(extracted)

if new_count > 0:
    new_pct = (new_count * 100) // extracted_count
    if new_pct > max_new_pct:
        print(f"ERROR: {new_count} new products ({new_pct}%) exceeds threshold ({max_new_pct}%)")
        with open(error_file, "w") as f:
            f.write(f"MeasureUp monitor detected {new_count} new products ({new_pct}% of total). "
                    f"This exceeds the {max_new_pct}% threshold, suggesting HTML structure may have changed.")
        with open(github_output, "a") as f:
            f.write("extraction_failed=true\n")
        exit(1)

if new_count == 0:
    print("No new products found.")
    with open(github_output, "a") as f:
        f.write("new_products=false\n")
        f.write("extraction_failed=false\n")
else:
    print(f"Found {new_count} new products!")
    with open(report_file, "w") as f:
        f.write("## New MeasureUp Products Detected\n\n")
        f.write("| Product | Exam Code | Type | URL |\n")
        f.write("|---------|-----------|------|-----|\n")
        for p in new_products:
            f.write(f"| {p['name']} | {p.get('examCode', 'N/A')} | {p['type']} | [Link]({p['url']}) |\n")
        f.write(f"\n---\n")
        f.write(f"- **Previous baseline:** {baseline['totalProducts']} products\n")
        f.write(f"- **Current scan:** {extracted_count} products\n")
        f.write(f"- **New products:** {new_count}\n")
    with open(github_output, "a") as f:
        f.write("new_products=true\n")
        f.write("extraction_failed=false\n")

baseline["lastChecked"] = datetime.datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ")
baseline["totalProducts"] = extracted_count
baseline["products"] = extracted

with open(baseline_file, "w") as f:
    json.dump(baseline, f, indent=2)

print(f"Baseline updated with {extracted_count} products")
PYEOF

echo "=== Done ==="
