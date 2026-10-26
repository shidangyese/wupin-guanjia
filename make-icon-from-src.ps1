# Build icon set from icon-src.jpg (center-crop watercolor box). ASCII only.
Add-Type -AssemblyName System.Drawing
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$src = [System.Drawing.Image]::FromFile((Join-Path $root 'icon-src.jpg'))

function RoundedPath([float]$w, [float]$h, [float]$r) {
  $gp = New-Object System.Drawing.Drawing2D.GraphicsPath
  $d = $r * 2
  $gp.AddArc(0, 0, $d, $d, 180, 90)
  $gp.AddArc($w - $d, 0, $d, $d, 270, 90)
  $gp.AddArc($w - $d, $h - $d, $d, $d, 0, 90)
  $gp.AddArc(0, $h - $d, $d, $d, 90, 90)
  $gp.CloseFigure()
  return $gp
}

# Center-crop a square of (keep * min side) and scale to $outSize. If $rounded, clip to rounded corners (render 2x then downscale).
function MakeIcon([double]$keep, [int]$outSize, [bool]$rounded, [string]$out) {
  $side = [int]([Math]::Min($src.Width, $src.Height) * $keep)
  $sx = [int](($src.Width - $side) / 2)
  $sy = [int](($src.Height - $side) / 2)
  $hi = $outSize * 2
  $bmp = New-Object System.Drawing.Bitmap $hi, $hi
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  if ($rounded) {
    $gp = RoundedPath $hi $hi ([float]($hi * 0.22))
    $g.SetClip($gp)
    $gp.Dispose()
  }
  $g.DrawImage($src, (New-Object System.Drawing.Rectangle 0, 0, $hi, $hi), (New-Object System.Drawing.Rectangle $sx, $sy, $side, $side), [System.Drawing.GraphicsUnit]::Pixel)
  $g.Dispose()
  $outBmp = New-Object System.Drawing.Bitmap $outSize, $outSize
  $g2 = [System.Drawing.Graphics]::FromImage($outBmp)
  $g2.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g2.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $g2.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g2.DrawImage($bmp, 0, 0, $outSize, $outSize)
  $g2.Dispose()
  $outBmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
  $outBmp.Dispose(); $bmp.Dispose()
  Write-Host ("OK  " + $out)
}

# any icons: tighter crop so the box fills the frame
MakeIcon 0.68 512 $true (Join-Path $root 'icon-512.png')
MakeIcon 0.68 192 $true (Join-Path $root 'icon-192.png')
# maskable + apple: full-bleed square, looser crop keeps box inside safe zone
MakeIcon 0.82 512 $false (Join-Path $root 'icon-maskable-512.png')
MakeIcon 0.82 180 $false (Join-Path $root 'apple-touch-icon.png')

# favicon svg with embedded png
$png64 = [Convert]::ToBase64String([System.IO.File]::ReadAllBytes((Join-Path $root 'icon-512.png')))
$svg = '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 512 512" width="512" height="512"><image href="data:image/png;base64,' + $png64 + '" xlink:href="data:image/png;base64,' + $png64 + '" width="512" height="512"/></svg>'
[System.IO.File]::WriteAllText((Join-Path $root 'icon.svg'), $svg)
Write-Host ("OK  " + (Join-Path $root 'icon.svg'))
$src.Dispose()
Write-Host 'done'
