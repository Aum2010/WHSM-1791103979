$root = "C:\WH-Test"
$port = 8000
$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("http://localhost:$port/")

try { $listener.Start() }
catch {
    Write-Host "[ERR] Cannot start listener." -ForegroundColor Red
    Write-Host "Please run as Administrator." -ForegroundColor Yellow
    Read-Host "Press Enter"; exit 1
}

Clear-Host
Write-Host "================================================" -ForegroundColor Green
Write-Host "   WH-Test Server is RUNNING" -ForegroundColor Green
Write-Host "================================================" -ForegroundColor Green
Write-Host ""
Write-Host "   Open these URLs in browser:" -ForegroundColor White
Write-Host "     V4:   http://localhost:$port/V4.html" -ForegroundColor Cyan
Write-Host "     WH13: http://localhost:$port/WH13.html" -ForegroundColor Cyan
Write-Host ""
Write-Host "   DO NOT CLOSE THIS WINDOW" -ForegroundColor Yellow
Write-Host "   Press Ctrl+C to stop" -ForegroundColor Yellow
Write-Host ""

$mimes = @{
    ".html"="text/html; charset=utf-8"
    ".htm"="text/html; charset=utf-8"
    ".css"="text/css; charset=utf-8"
    ".js"="application/javascript; charset=utf-8"
    ".json"="application/json; charset=utf-8"
    ".png"="image/png"; ".jpg"="image/jpeg"; ".jpeg"="image/jpeg"
    ".gif"="image/gif"; ".svg"="image/svg+xml"; ".ico"="image/x-icon"
    ".woff"="font/woff"; ".woff2"="font/woff2"; ".ttf"="font/ttf"
}

try {
    while ($listener.IsListening) {
        $ctx = $listener.GetContext()
        $req = $ctx.Request
        $res = $ctx.Response
        $rel = $req.Url.LocalPath.TrimStart('/')
        if ([string]::IsNullOrEmpty($rel)) { $rel = "V4.html" }
        $file = Join-Path $root $rel
        if (Test-Path $file -PathType Leaf) {
            $ext = [System.IO.Path]::GetExtension($file).ToLower()
            $ct = if ($mimes.ContainsKey($ext)) { $mimes[$ext] } else { "application/octet-stream" }
            $bytes = [System.IO.File]::ReadAllBytes($file)
            $res.ContentType = $ct
            $res.ContentLength64 = $bytes.Length
            $res.OutputStream.Write($bytes, 0, $bytes.Length)
            Write-Host "  [200] $rel" -ForegroundColor DarkGreen
        } else {
            $res.StatusCode = 404
            $body = [System.Text.Encoding]::UTF8.GetBytes("404 Not Found")
            $res.ContentLength64 = $body.Length
            $res.OutputStream.Write($body, 0, $body.Length)
            Write-Host "  [404] $rel" -ForegroundColor DarkRed
        }
        $res.Close()
    }
} finally {
    $listener.Stop()
    $listener.Close()
}