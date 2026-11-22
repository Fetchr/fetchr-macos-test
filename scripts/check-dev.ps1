"--- port 1420 listeners ---"
Get-NetTCPConnection -LocalPort 1420 -ErrorAction SilentlyContinue | Select-Object LocalAddress, State, OwningProcess | Format-Table -AutoSize
"--- node/npm/tauri processes ---"
Get-CimInstance Win32_Process -Filter "Name='node.exe' OR Name='npm.cmd' OR Name='cmd.exe' OR Name='fetchr.exe'" |
  Where-Object { $_.CommandLine -match 'tauri|vite|1420|fetchr' } |
  Select-Object ProcessId, Name, @{n='Cmd';e={$_.CommandLine.Substring(0, [Math]::Min(120, $_.CommandLine.Length))}} | Format-List
