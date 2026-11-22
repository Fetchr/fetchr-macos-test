$fetchr = Get-Process -Name fetchr -ErrorAction SilentlyContinue
$node = Get-Process -Name node -ErrorAction SilentlyContinue
"cargo/tauri processes:"
Get-CimInstance Win32_Process -Filter "Name='fetchr.exe'" | Select-Object ProcessId, CommandLine | Format-List
"fetchr.exe count: " + ($fetchr | Measure-Object).Count
"node.exe count: " + ($node | Measure-Object).Count
"port 1420:"
(Get-NetTCPConnection -LocalPort 1420 -State Listen -ErrorAction SilentlyContinue | Measure-Object).Count
