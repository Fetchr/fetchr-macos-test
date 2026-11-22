param([string]$Out = "_shots\screen.png", [string]$ProcName = "fetchr", [int]$SettleMs = 900)
Add-Type -AssemblyName System.Windows.Forms,System.Drawing
$src = @"
using System;
using System.Runtime.InteropServices;
public class FG {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool f);
  [DllImport("user32.dll")] public static extern void SwitchToThisWindow(IntPtr hWnd, bool fAltTab);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT r);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  public struct RECT { public int Left, Top, Right, Bottom; }
}
"@
Add-Type -TypeDefinition $src -ReferencedAssemblies System.Windows.Forms
$p = Get-Process -Name $ProcName -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
if ($null -eq $p) { Write-Error "window not found"; exit 1 }
$h = $p.MainWindowHandle
$r = New-Object FG+RECT
[FG]::GetWindowRect($h, [ref]$r) | Out-Null
Write-Output ("rect: {0},{1} {2}x{3} iconic={4}" -f $r.Left,$r.Top,($r.Right-$r.Left),($r.Bottom-$r.Top),[FG]::IsIconic($h))
if ([FG]::IsIconic($h)) { [FG]::ShowWindow($h, 9) | Out-Null; Start-Sleep -Milliseconds 400 }

$fg = [FG]::GetForegroundWindow()
$fgThread = [FG]::GetWindowThreadProcessId($fg, [ref]([uint32]$null = 0))
$myThread = [FG]::GetCurrentThreadId()
[FG]::AttachThreadInput($myThread, $fgThread, $true) | Out-Null
[FG]::BringWindowToTop($h) | Out-Null
[FG]::ShowWindow($h, 5) | Out-Null  # SW_SHOW
[FG]::SetForegroundWindow($h) | Out-Null
[FG]::AttachThreadInput($myThread, $fgThread, $false) | Out-Null
[FG]::SwitchToThisWindow($h, $true)
Start-Sleep -Milliseconds $SettleMs
$fg2 = [FG]::GetForegroundWindow()
Write-Output ("foreground ours: " + ($fg2 -eq $h))

$b = [System.Windows.Forms.SystemInformation]::VirtualScreen
$bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($b.Left, $b.Top, 0, 0, $bmp.Size)
$dir = Split-Path -Parent $Out
if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir | Out-Null }
$bmp.Save((Resolve-Path .).Path + "\" + $Out, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose()
Write-Output "saved $Out"
