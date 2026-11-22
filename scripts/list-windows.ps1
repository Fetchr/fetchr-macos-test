Get-Process | Where-Object { $_.MainWindowTitle -ne '' -and ($_.ProcessName -match 'fetchr|webview|msedge' -or $_.MainWindowTitle -match 'Fetchr') } |
  Select-Object Id, ProcessName, MainWindowTitle, MainWindowHandle | Format-Table -AutoSize
