# Process all exam files to move LinkCards with descriptions outside CardGrid

$folders = @(
    "c:\Users\micha\OneDrive\Desktop\hub-1\src\content\docs\azure",
    "c:\Users\micha\OneDrive\Desktop\hub-1\src\content\docs\dynamics",
    "c:\Users\micha\OneDrive\Desktop\hub-1\src\content\docs\github",
    "c:\Users\micha\OneDrive\Desktop\hub-1\src\content\docs\microsoft365",
    "c:\Users\micha\OneDrive\Desktop\hub-1\src\content\docs\power",
    "c:\Users\micha\OneDrive\Desktop\hub-1\src\content\docs\security"
)

function Process-MDXFile {
    param([string]$filePath)
    
    $content = Get-Content -Path $filePath -Raw -Encoding UTF8
    $lines = $content -split "`n"
    $newLines = @()
    $inTabItem = $false
    $inCardGrid = $false
    $tabItemIndent = ""
    $cardGridLines = @()
    $beforeCardGridLines = @()
    $hasCardGrid = $false
    $tabItemHasContent = $false
    
    for ($i = 0; $i -lt $lines.Count; $i++) {
        $line = $lines[$i]
        
        # Check if we're entering a TabItem
        if ($line -match '^\s*<TabItem label=".*?">') {
            $inTabItem = $true
            $tabItemIndent = $line -replace '<TabItem.*', ''
            $beforeCardGridLines = @()
            $cardGridLines = @()
            $hasCardGrid = $false
            $tabItemHasContent = $false
            $newLines += $line
            continue
        }
        
        # Check if we're exiting a TabItem
        if ($inTabItem -and $line -match '^\s*</TabItem>') {
            # If we collected lines before CardGrid or in CardGrid, process them
            if ($beforeCardGridLines.Count -gt 0 -or $cardGridLines.Count -gt 0) {
                # Add beforeCardGrid lines (these are LinkCards with descriptions)
                foreach ($bl in $beforeCardGridLines) {
                    $newLines += $bl
                }
                
                # Add CardGrid with remaining content
                if ($cardGridLines.Count -gt 0) {
                    $newLines += "$tabItemIndent  <CardGrid>"
                    foreach ($cl in $cardGridLines) {
                        $newLines += $cl
                    }
                    $newLines += "$tabItemIndent  </CardGrid>"
                } elseif (-not $hasCardGrid -and $tabItemHasContent) {
                    # Add empty CardGrid if none existed
                    $newLines += "$tabItemIndent  <CardGrid>"
                    $newLines += "$tabItemIndent  </CardGrid>"
                }
            } elseif (-not $hasCardGrid -and $tabItemHasContent) {
                # No CardGrid found but has content, add empty one
                $newLines += "$tabItemIndent  <CardGrid>"
                $newLines += "$tabItemIndent  </CardGrid>"
            }
            
            $newLines += $line
            $inTabItem = $false
            $inCardGrid = $false
            continue
        }
        
        # Inside TabItem
        if ($inTabItem) {
            # Check for CardGrid start
            if ($line -match '^\s*<CardGrid>') {
                $inCardGrid = $true
                $hasCardGrid = $true
                continue
            }
            
            # Check for CardGrid end
            if ($line -match '^\s*</CardGrid>') {
                $inCardGrid = $false
                continue
            }
            
            # Process LinkCard lines
            if ($line -match '<LinkCard.*?description=') {
                # LinkCard with description
                $tabItemHasContent = $true
                if ($inCardGrid) {
                    # Move to before CardGrid
                    $beforeCardGridLines += $line
                } else {
                    # Already outside, keep it
                    $beforeCardGridLines += $line
                }
            } elseif ($line -match '<LinkCard') {
                # LinkCard without description
                $tabItemHasContent = $true
                if ($inCardGrid) {
                    # Keep in CardGrid
                    $cardGridLines += $line
                } else {
                    # Outside CardGrid - this shouldn't happen normally, but collect it
                    $beforeCardGridLines += $line
                }
            } else {
                # Other content
                if ($line.Trim() -ne '') {
                    $tabItemHasContent = $true
                }
                # Keep other lines as they are
                if (-not $inCardGrid) {
                    $newLines += $line
                }
            }
        } else {
            # Outside TabItem, keep line as is
            $newLines += $line
        }
    }
    
    # Write back
    $newContent = $newLines -join "`n"
    Set-Content -Path $filePath -Value $newContent -Encoding UTF8 -NoNewline
    Write-Output "Processed: $(Split-Path -Leaf $filePath)"
}

$totalFiles = 0
foreach ($folder in $folders) {
    if (Test-Path $folder) {
        $files = Get-ChildItem -Path $folder -Filter "*.mdx"
        foreach ($file in $files) {
            Process-MDXFile -filePath $file.FullName
            $totalFiles++
        }
    }
}

Write-Output "Processing complete! ($totalFiles files processed)"
