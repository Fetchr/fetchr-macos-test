; PF_AVX_INSTRUCTIONS_AVAILABLE. ONNX Runtime dies on start without AVX, and
; the user would only see the app silently refuse to open.
!define FETCHR_PF_AVX 39
!define FETCHR_PF_AVX2 40
!define FETCHR_VCREDIST_URL "https://aka.ms/vs/17/release/vc_redist.x64.exe"
; onnxruntime.dll needs a recent msvcp140; older 14.x runtimes crash inside it.
!define FETCHR_VCREDIST_MIN_MINOR 40

!macro FETCHR_CHECK_CPU
  Push $0
  System::Call 'kernel32::IsProcessorFeaturePresent(i ${FETCHR_PF_AVX}) i .r0'
  ${If} $0 = 0
    MessageBox MB_OK|MB_ICONSTOP "Этот процессор не поддерживает инструкции AVX, поэтому Fetchr на нём не запустится.$\r$\n$\r$\nThis CPU does not support AVX, so Fetchr cannot run on it." /SD IDOK
    Abort
  ${EndIf}
  System::Call 'kernel32::IsProcessorFeaturePresent(i ${FETCHR_PF_AVX2}) i .r0'
  ${If} $0 = 0
    MessageBox MB_YESNO|MB_ICONEXCLAMATION "Процессор не поддерживает AVX2. Нейросетевые инструменты Fetchr могут работать медленно или не запускаться. Продолжить установку?$\r$\n$\r$\nThis CPU does not support AVX2. Fetchr's AI tools may be slow or fail to start. Continue?" /SD IDYES IDYES +2
    Abort
  ${EndIf}
  Pop $0
!macroend

; Sets $0 to 1 when a new enough x64 VC++ runtime is registered, otherwise 0.
!macro FETCHR_VCREDIST_READY
  SetRegView 64
  ReadRegDWORD $0 HKLM "SOFTWARE\Microsoft\VisualStudio\14.0\VC\Runtimes\x64" "Installed"
  ReadRegDWORD $1 HKLM "SOFTWARE\Microsoft\VisualStudio\14.0\VC\Runtimes\x64" "Minor"
  SetRegView lastused
  ${If} $0 = 1
  ${AndIf} $1 >= ${FETCHR_VCREDIST_MIN_MINOR}
    StrCpy $0 1
  ${Else}
    StrCpy $0 0
  ${EndIf}
!macroend

!macro FETCHR_INSTALL_VCREDIST
  Push $0
  Push $1
  !insertmacro FETCHR_VCREDIST_READY
  ${If} $0 = 0
    DetailPrint "Downloading Microsoft Visual C++ Redistributable..."
    Delete "$TEMP\fetchr_vc_redist.x64.exe"
    nsExec::ExecToLog 'curl.exe -fsSL --retry 2 --connect-timeout 20 --max-time 600 -o "$TEMP\fetchr_vc_redist.x64.exe" "${FETCHR_VCREDIST_URL}"'
    Pop $0
    ${IfNot} ${FileExists} "$TEMP\fetchr_vc_redist.x64.exe"
      nsExec::ExecToLog `powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "[Net.ServicePointManager]::SecurityProtocol='Tls12'; Invoke-WebRequest -UseBasicParsing -Uri '${FETCHR_VCREDIST_URL}' -OutFile '$TEMP\fetchr_vc_redist.x64.exe'"`
      Pop $0
    ${EndIf}
    ; It runs elevated, so only a file Microsoft signed is allowed to run:
    ; anything else in %TEMP% under this name is deleted instead.
    ${If} ${FileExists} "$TEMP\fetchr_vc_redist.x64.exe"
      nsExec::ExecToLog `powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$$s = Get-AuthenticodeSignature -LiteralPath '$TEMP\fetchr_vc_redist.x64.exe'; if ($$s.Status -eq 'Valid' -and $$s.SignerCertificate.Subject -like 'CN=Microsoft Corporation,*') { exit 0 } else { exit 1 }"`
      Pop $1
      ${If} $1 != 0
        DetailPrint "Visual C++ Redistributable is not signed by Microsoft - skipped."
        Delete "$TEMP\fetchr_vc_redist.x64.exe"
      ${EndIf}
    ${EndIf}
    ${If} ${FileExists} "$TEMP\fetchr_vc_redist.x64.exe"
      DetailPrint "Installing Microsoft Visual C++ Redistributable..."
      ; The runtime is machine-wide, so this one step asks for elevation.
      ExecShellWait "runas" "$TEMP\fetchr_vc_redist.x64.exe" "/install /quiet /norestart"
      Delete "$TEMP\fetchr_vc_redist.x64.exe"
    ${EndIf}
    !insertmacro FETCHR_VCREDIST_READY
    ${If} $0 = 0
      MessageBox MB_OK|MB_ICONEXCLAMATION "Не удалось установить Microsoft Visual C++ Redistributable. Без него Fetchr может не запуститься. Скачайте его вручную: ${FETCHR_VCREDIST_URL}$\r$\n$\r$\nCould not install the Microsoft Visual C++ Redistributable. Fetchr may not start without it." /SD IDOK
    ${EndIf}
  ${EndIf}
  Pop $1
  Pop $0
!macroend

!macro NSIS_HOOK_POSTINSTALL
  !insertmacro FETCHR_INSTALL_VCREDIST
!macroend

!macro NSIS_HOOK_PREINSTALL
  ${If} $UpdateMode <> 1
    !insertmacro FETCHR_CHECK_CPU
  ${EndIf}

  DetailPrint "Preparing Fetchr update without deleting user data..."

  nsExec::ExecToLog 'cmd /c taskkill /F /T /IM fetchr.exe 2>nul'
  nsExec::ExecToLog 'cmd /c taskkill /F /T /IM "Fetchr.exe" 2>nul'
  nsExec::ExecToLog 'cmd /c taskkill /F /T /IM stream-cutter.exe 2>nul'
  nsExec::ExecToLog 'cmd /c taskkill /F /T /IM "Stream Cutter.exe" 2>nul'

  ; Do not run the current Fetchr uninstaller and do not recursively remove
  ; AppData folders here. Tauri/WebView settings, localStorage, workspace
  ; layouts, presets, and the beta license live under user data directories.
  ; NSIS can overwrite the existing Fetchr installation in-place.

  ; An in-app update runs with /UPDATE, and in that mode the Tauri template
  ; does not create shortcuts again: the current ones have to survive it.
  ${If} $UpdateMode <> 1
    Delete "$DESKTOP\Fetchr.lnk"
    Delete "$SMPROGRAMS\Fetchr.lnk"
  ${EndIf}

  Delete "$DESKTOP\Stream Cutter.lnk"
  Delete "$DESKTOP\StreamCutter.lnk"
  Delete "$DESKTOP\stream-cutter.lnk"
  Delete "$SMPROGRAMS\Stream Cutter.lnk"
  Delete "$SMPROGRAMS\StreamCutter.lnk"
  Delete "$SMPROGRAMS\stream-cutter.lnk"
  RMDir "$SMPROGRAMS\Stream Cutter"
  RMDir "$SMPROGRAMS\StreamCutter"
  RMDir "$SMPROGRAMS\stream-cutter"
!macroend
