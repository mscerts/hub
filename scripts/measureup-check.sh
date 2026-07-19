#!/bin/bash
set -euo pipefail

BASE_URL="${BASE_URL:-https://www.measureup.com/microsoft.html}"
BASELINE_FILE="${BASELINE_FILE:-src/data_files/measureup-products.json}"
TEMP_DIR="${TEMP_DIR:-/tmp/measureup-scan}"
ALL_PRODUCTS_FILE="${ALL_PRODUCTS_FILE:-$TEMP_DIR/all-products.jsonl}"
REPORT_FILE="${REPORT_FILE:-/tmp/measureup-report.md}"
ERROR_FILE="${ERROR_FILE:-/tmp/measureup-error.md}"
GITHUB_OUTPUT="${GITHUB_OUTPUT:-/tmp/github-output}"
export GITHUB_OUTPUT

MIN_PRODUCTS="${MIN_PRODUCTS:-100}"
MAX_NEW_PCT="${MAX_NEW_PCT:-50}"

mkdir -p "$TEMP_DIR"
> "$ALL_PRODUCTS_FILE"

echo "=== MeasureUp Monitor ==="
echo "Started: $(date -u +%Y-%m-%dT%H:%M:%SZ)"

fetch_page() {
    local url="$1"
    local output_file="$2"
    local label="$3"
    local attempt

    for attempt in 1 2 3; do
        curl -sL --fail --max-time 30 --retry 2 --retry-delay 5 \
            -H "User-Agent: Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36" \
            -H "Accept: text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8" \
            "$url" -o "$output_file" 2>/dev/null || true

        if [ -s "$output_file" ] && grep -q "var dl4Objects" "$output_file"; then
            return 0
        fi

        echo "WARNING: $label fetch attempt $attempt did not contain product data"
        sleep $((attempt * 5))
    done

    return 1
}

write_extraction_failure() {
    local message="$1"
    echo "$message" > "$ERROR_FILE"
    echo "new_products=false" >> "$GITHUB_OUTPUT"
    echo "extraction_failed=true" >> "$GITHUB_OUTPUT"
    echo "baseline_updated=false" >> "$GITHUB_OUTPUT"
}

# --- Step 1: Fetch page 1, detect total pages ---
echo "Fetching page 1..."

if ! fetch_page "$BASE_URL" "$TEMP_DIR/page-1.html" "page 1"; then
  echo "ERROR: Failed to fetch page 1"
    write_extraction_failure "Failed to fetch MeasureUp page 1 with product data. Site may be down, blocking requests, or returning incomplete content."
  exit 1
fi

TOTAL=$(grep -oP 'toolbar-number">\K\d+' "$TEMP_DIR/page-1.html" | sed -n '3p')

if [ -z "$TOTAL" ] || [ "$TOTAL" -lt "$MIN_PRODUCTS" ]; then
  echo "ERROR: Total=$TOTAL (expected >$MIN_PRODUCTS)."
    write_extraction_failure "MeasureUp extraction failed. Got total=$TOTAL (expected >$MIN_PRODUCTS)."
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
  
    if ! fetch_page "${BASE_URL}?p=$p" "$TEMP_DIR/page-$p.html" "page $p"; then
        echo "WARNING: Failed to fetch product data for page $p, skipping"
    continue
  fi
  
  extract_page "$TEMP_DIR/page-$p.html" >> "$ALL_PRODUCTS_FILE"
done

# Deduplicate by normalized product identity
python3 -c "
import json

def product_key(product):
    product_id = str(product.get('id', '')).strip()
    if product_id:
        return product_id
    name = product.get('name', '').strip().lower()
    return product.get('type', '') + '|' + name

seen = set()
products = []

with open('$ALL_PRODUCTS_FILE') as f:
    for line in f:
        line = line.strip()
        if not line:
            continue
        product = json.loads(line)
        product['id'] = str(product.get('id', '')).strip()
        key = product_key(product)
        if key in seen:
            continue
        seen.add(key)
        products.append(product)

with open('$ALL_PRODUCTS_FILE', 'w') as f:
    for product in products:
        print(json.dumps(product, sort_keys=True), file=f)
"
EXTRACTED_COUNT=$(wc -l < "$ALL_PRODUCTS_FILE")

echo "Extracted $EXTRACTED_COUNT unique products"

if [ "$EXTRACTED_COUNT" -lt "$MIN_PRODUCTS" ]; then
  echo "ERROR: Only $EXTRACTED_COUNT products (expected >$MIN_PRODUCTS)."
    write_extraction_failure "MeasureUp extraction partially failed. Got $EXTRACTED_COUNT products (expected >$MIN_PRODUCTS). The scan was ignored so the baseline was not changed and no new-product notification was sent."
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
    echo "baseline_updated=true" >> "$GITHUB_OUTPUT"
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

def product_key(product):
    product_id = str(product.get("id", "")).strip()
    if product_id:
        return product_id
    name = product.get("name", "").strip().lower()
    return product.get("type", "") + "|" + name

def normalize_product(product):
    normalized = dict(product)
    normalized["id"] = str(normalized.get("id", "")).strip()
    return normalized

def write_output(**values):
    with open(github_output, "a") as f:
        for key, value in values.items():
            f.write(f"{key}={str(value).lower()}\n")

with open(baseline_file) as f:
    baseline = json.load(f)

baseline_products = [normalize_product(p) for p in baseline["products"]]
baseline_ids = {product_key(p) for p in baseline_products}
baseline_count = len(baseline_products)

extracted = []
with open(extracted_file) as f:
    for line in f:
        line = line.strip()
        if line:
            extracted.append(normalize_product(json.loads(line)))

new_products = [p for p in extracted if product_key(p) not in baseline_ids]
new_count = len(new_products)
extracted_count = len(extracted)
list_increased = extracted_count > baseline_count
baseline_changed = {product_key(p) for p in extracted} != baseline_ids
should_update_baseline = False

if new_count > 0 and list_increased:
    new_pct = (new_count * 100) // extracted_count
    if new_pct > max_new_pct:
        print(f"ERROR: {new_count} new products ({new_pct}%) exceeds threshold ({max_new_pct}%)")
        with open(error_file, "w") as f:
            f.write(f"MeasureUp monitor detected {new_count} new products ({new_pct}% of total). "
                    f"This exceeds the {max_new_pct}% threshold, suggesting HTML structure may have changed.")
        write_output(extraction_failed=True, baseline_updated=False)
        exit(1)

if new_count == 0 or not list_increased:
    if new_count > 0:
        print(f"Detected {new_count} product ID changes, but total did not increase ({baseline_count} -> {extracted_count}); no notification will be sent and baseline will remain unchanged.")
    else:
        print("No new products found.")
    write_output(new_products=False, extraction_failed=False, baseline_updated=False)
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
    write_output(new_products=True, extraction_failed=False, baseline_updated=True)
    should_update_baseline = True

if should_update_baseline and baseline_changed:
    baseline["lastChecked"] = datetime.datetime.now(datetime.UTC).strftime("%Y-%m-%dT%H:%M:%SZ")
    baseline["totalProducts"] = extracted_count
    baseline["products"] = extracted

    with open(baseline_file, "w") as f:
        json.dump(baseline, f, indent=2)

    print(f"Baseline updated with {extracted_count} products")
else:
    print("Baseline unchanged")
PYEOF

echo "=== Done ==="
