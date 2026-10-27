# Draws the Plecks brand images (app icon, header mark, wordmark, splash) with
# System.Drawing, so it runs on any Windows box with no extra installs.
#   powershell -ExecutionPolicy Bypass -File scripts/make-plecks-brand.ps1
Add-Type -AssemblyName System.Drawing
$root = Split-Path -Parent $PSScriptRoot

$cream = [System.Drawing.Color]::FromArgb(255, 255, 247, 230)
$coral = [System.Drawing.Color]::FromArgb(255, 255, 76, 66)

function New-Canvas($w, $h) {
  $bmp = New-Object System.Drawing.Bitmap $w, $h, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = 'AntiAlias'
  $g.InterpolationMode = 'HighQualityBicubic'
  $g.PixelOffsetMode = 'HighQuality'
  $g.TextRenderingHint = 'AntiAliasGridFit'
  return @($bmp, $g)
}

function RoundRect($x, $y, $w, $h, $r) {
  $p = New-Object System.Drawing.Drawing2D.GraphicsPath
  [single]$d = $r * 2
  $p.AddArc([single]$x, [single]$y, $d, $d, [single]180, [single]90)
  $p.AddArc([single]($x + $w - $d), [single]$y, $d, $d, [single]270, [single]90)
  $p.AddArc([single]($x + $w - $d), [single]($y + $h - $d), $d, $d, [single]0, [single]90)
  $p.AddArc([single]$x, [single]($y + $h - $d), $d, $d, [single]90, [single]90)
  $p.CloseFigure()
  return $p
}

function GX($v) { [single]($script:ox + $v * $script:unit) }
function GY($v) { [single]($script:oy + $v * $script:unit) }

# The mark on a 100-unit grid: dark tile, cream "P", coral play button in its bowl.
function Draw-Mark($g, $x, $y, $size, [bool]$tile = $true) {
  $u = $size / 100.0
  $script:ox = $x; $script:oy = $y; $script:unit = $u
  if ($tile) {
    $t = RoundRect $x $y $size $size (22 * $u)
    $grad = New-Object System.Drawing.Drawing2D.LinearGradientBrush ([System.Drawing.PointF]::new($x, $y)), ([System.Drawing.PointF]::new($x, $y + $size)),
      ([System.Drawing.Color]::FromArgb(255, 44, 48, 60)), ([System.Drawing.Color]::FromArgb(255, 16, 18, 24))
    $g.FillPath($grad, $t)
    $edge = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(40, 255, 247, 230)), ([Math]::Max(1, 1.2 * $u))
    $g.DrawPath($edge, $t)
  }
  # P: stem 27..41, bowl centered (53,42) with outer r 24 / inner r 11.
  $p = New-Object System.Drawing.Drawing2D.GraphicsPath
  $p.FillMode = 'Alternate'
  $p.StartFigure()
  $p.AddLine((GX 27), (GY 18), (GX 53), (GY 18))
  $p.AddArc((GX 29), (GY 18), [single](48 * $u), [single](48 * $u), [single]270, [single]180)
  $p.AddLine((GX 53), (GY 66), (GX 41), (GY 66))
  $p.AddLine((GX 41), (GY 66), (GX 41), (GY 82))
  $p.AddLine((GX 41), (GY 82), (GX 27), (GY 82))
  $p.CloseFigure()
  $p.StartFigure()
  $p.AddLine((GX 41), (GY 31), (GX 53), (GY 31))
  $p.AddArc((GX 42), (GY 31), [single](22 * $u), [single](22 * $u), [single]270, [single]180)
  $p.AddLine((GX 53), (GY 53), (GX 41), (GY 53))
  $p.CloseFigure()
  $g.FillPath((New-Object System.Drawing.SolidBrush $cream), $p)
  # Play triangle, softened corners.
  $tri = New-Object System.Drawing.Drawing2D.GraphicsPath
  $tri.AddPolygon([System.Drawing.PointF[]]@(
    [System.Drawing.PointF]::new((GX 47.5), (GY 35.5)),
    [System.Drawing.PointF]::new((GX 47.5), (GY 48.5)),
    [System.Drawing.PointF]::new((GX 58.5), (GY 42))))
  $g.FillPath((New-Object System.Drawing.SolidBrush $coral), $tri)
  $soft = New-Object System.Drawing.Pen $coral, (2.2 * $u)
  $soft.LineJoin = 'Round'
  $g.DrawPath($soft, $tri)
}

function Save($bmp, $rel) {
  $path = Join-Path $root $rel
  $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
  Write-Output "$rel $($bmp.Width)x$($bmp.Height)"
}

# Icons (tile edge-to-edge, transparent corners).
foreach ($s in 117, 128, 256, 512, 1024) {
  $c = New-Canvas $s $s
  Draw-Mark $c[1] 0 0 $s
  Save $c[0] "assets/icons/app-icon-$s.png"
  if ($s -eq 117) { Save $c[0] 'app/icon.png'; Save $c[0] 'assets/tizen/icon-dev-117x117.png' }
  if ($s -eq 512) { Save $c[0] 'app/img/mascot-512.png' }
  $c[1].Dispose(); $c[0].Dispose()
}

# Header mark (shown at 84x84 in the top bar, 2x for sharpness).
$c = New-Canvas 168 168
Draw-Mark $c[1] 0 0 168
Save $c[0] 'app/img/mark.png'
$c[1].Dispose(); $c[0].Dispose()

function Draw-Wordmark($g, $x, $y, $px) {
  $font = New-Object System.Drawing.Font 'Bahnschrift SemiBold Condensed', $px, ([System.Drawing.FontStyle]::Regular), ([System.Drawing.GraphicsUnit]::Pixel)
  $fmt = [System.Drawing.StringFormat]::GenericTypographic
  $w1 = $g.MeasureString('Ple', $font, 10000, $fmt).Width
  $g.DrawString('Ple', $font, (New-Object System.Drawing.SolidBrush $cream), $x, $y, $fmt)
  $g.DrawString('cks', $font, (New-Object System.Drawing.SolidBrush $coral), $x + $w1, $y, $fmt)
  return $w1 + $g.MeasureString('cks', $font, 10000, $fmt).Width
}

# Wordmark: measure, then draw on a tight canvas 96px tall.
$c = New-Canvas 10 10
$font = New-Object System.Drawing.Font 'Bahnschrift SemiBold Condensed', 112, ([System.Drawing.FontStyle]::Regular), ([System.Drawing.GraphicsUnit]::Pixel)
$fmt = [System.Drawing.StringFormat]::GenericTypographic
$ww = [int][Math]::Ceiling($c[1].MeasureString('Plecks', $font, 10000, $fmt).Width) + 4
$c[1].Dispose(); $c[0].Dispose()
$c = New-Canvas $ww 96
[void](Draw-Wordmark $c[1] 0 -13 112)
Save $c[0] 'app/img/wordmark.png'
$c[1].Dispose(); $c[0].Dispose()

# Splash.
$c = New-Canvas 1920 1080
$g = $c[1]
$bg = New-Object System.Drawing.Drawing2D.LinearGradientBrush ([System.Drawing.PointF]::new(0, 0)), ([System.Drawing.PointF]::new(0, 1080)),
  ([System.Drawing.Color]::FromArgb(255, 24, 27, 35)), ([System.Drawing.Color]::FromArgb(255, 11, 13, 18))
$g.FillRectangle($bg, 0, 0, 1920, 1080)
$glow = New-Object System.Drawing.Drawing2D.GraphicsPath
$glow.AddEllipse(560, 140, 800, 640)
$pg = New-Object System.Drawing.Drawing2D.PathGradientBrush $glow
$pg.CenterColor = [System.Drawing.Color]::FromArgb(70, 255, 76, 66)
$pg.SurroundColors = [System.Drawing.Color[]]@([System.Drawing.Color]::FromArgb(0, 255, 76, 66))
$g.FillPath($pg, $glow)
Draw-Mark $g 800 260 320
$sw = $g.MeasureString('Plecks', (New-Object System.Drawing.Font 'Bahnschrift SemiBold Condensed', 150, ([System.Drawing.FontStyle]::Regular), ([System.Drawing.GraphicsUnit]::Pixel)), 10000, $fmt).Width
[void](Draw-Wordmark $g ((1920 - $sw) / 2) 640 150)
$tag = New-Object System.Drawing.Font 'Bahnschrift SemiBold Condensed', 38, ([System.Drawing.FontStyle]::Regular), ([System.Drawing.GraphicsUnit]::Pixel)
$tw = $g.MeasureString('YOUR PLEX, YOUR CHANNELS', $tag, 10000, $fmt).Width
$g.DrawString('YOUR PLEX, YOUR CHANNELS', $tag, (New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(150, 255, 247, 230))), ((1920 - $tw) / 2), 850, $fmt)
Save $c[0] 'app/img/splash.png'
$g.Dispose(); $c[0].Dispose()
