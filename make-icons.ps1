# Generate app icon PNGs (run once). Pure ASCII to avoid codepage issues.
Add-Type -AssemblyName System.Drawing

$glyph = [char]0x7269  # CJK char "wu" (of "WuPin GuanJia")

function New-Icon([int]$size, [string]$path, [bool]$rounded) {
  $bg = [System.Drawing.Color]::FromArgb(255, 79, 70, 229)
  $bmp = New-Object System.Drawing.Bitmap $size, $size
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
  if ($rounded) {
    $g.Clear([System.Drawing.Color]::Transparent)
    $gp = New-Object System.Drawing.Drawing2D.GraphicsPath
    $r = [Math]::Max(1, [int]($size * 0.22))
    $d = $size - 1
    $gp.AddArc(0, 0, $r, $r, 180, 90)
    $gp.AddArc($d - $r, 0, $r, $r, 270, 90)
    $gp.AddArc($d - $r, $d - $r, $r, $r, 0, 90)
    $gp.AddArc(0, $d - $r, $r, $r, 90, 90)
    $gp.CloseFigure()
    $g.FillPath((New-Object System.Drawing.SolidBrush -ArgumentList $bg), $gp)
    $gp.Dispose()
  } else {
    $g.Clear($bg)
  }
  $font = New-Object System.Drawing.Font('Microsoft YaHei', [float]($size * 0.52), [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
  $sf = New-Object System.Drawing.StringFormat
  $sf.Alignment = [System.Drawing.StringAlignment]::Center
  $sf.LineAlignment = [System.Drawing.StringAlignment]::Center
  $rect = New-Object System.Drawing.RectangleF ([float]0), ([float]($size * 0.03)), ([float]$size), ([float]$size)
  $g.DrawString($glyph, $font, [System.Drawing.Brushes]::White, $rect, $sf)
  $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose(); $font.Dispose(); $sf.Dispose(); $bmp.Dispose()
  Write-Host ("OK  " + $path)
}

$root = $PSScriptRoot
New-Icon 512 (Join-Path $root 'icon-512.png') $true
New-Icon 192 (Join-Path $root 'icon-192.png') $true
New-Icon 512 (Join-Path $root 'icon-maskable-512.png') $false
New-Icon 180 (Join-Path $root 'apple-touch-icon.png') $false
Write-Host 'icons done'
