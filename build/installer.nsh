!include "getProcessInfo.nsh"
Var pid

!macro wineCheckAppRunning
  ${nsProcess::FindProcess} "${APP_EXECUTABLE_FILENAME}" $R0
  ${if} $R0 == 0
    ${ifNot} ${isUpdated}
      MessageBox MB_OKCANCEL|MB_ICONEXCLAMATION "$(appRunning)" /SD IDOK IDOK wine_stop_retry
      Quit
    ${endif}

    wine_stop_retry:
    DetailPrint "$(appClosing)"
    ${nsProcess::CloseProcess} "${APP_EXECUTABLE_FILENAME}" $R0
    Sleep 1000
    ${nsProcess::FindProcess} "${APP_EXECUTABLE_FILENAME}" $R0

    ${if} $R0 == 0
      ${nsProcess::KillProcess} "${APP_EXECUTABLE_FILENAME}" $R0
      Sleep 500
      ${nsProcess::FindProcess} "${APP_EXECUTABLE_FILENAME}" $R0
    ${endif}

    ${if} $R0 == 0
      MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "$(appCannotBeClosed)" /SD IDCANCEL IDRETRY wine_stop_retry
      Quit
    ${endif}
  ${endif}
!macroend

!macro customCheckAppRunning
  ; Wine's tasklist/taskkill fallback can return false positives and fail to close real processes.
  ClearErrors
  System::Call 'ntdll::wine_get_version() t.r0'
  ${if} ${Errors}
    ClearErrors
    !insertmacro IS_POWERSHELL_AVAILABLE
    !insertmacro _CHECK_APP_RUNNING
  ${else}
    ClearErrors
    !insertmacro wineCheckAppRunning
  ${endif}
!macroend

!macro customInstall
  ; Auto-updates preserve settings for schema migration; manual installs reset all known app-data names.
  ${ifNot} ${isUpdated}
    ${if} $installMode == "all"
      SetShellVarContext current
    ${endif}

    ; A manual reinstall resets reminder preferences, so remove their exact scheduled tasks too.
    nsExec::ExecToLog '"$SYSDIR\schtasks.exe" /Delete /TN "Commonwealth GA PvP Merc Fun" /F'
    Pop $R0
    nsExec::ExecToLog '"$SYSDIR\schtasks.exe" /Delete /TN "Commonwealth GA PvP Challenge Night" /F'
    Pop $R0

    RMDir /r "$APPDATA\${APP_FILENAME}"
    !ifdef APP_PRODUCT_FILENAME
      RMDir /r "$APPDATA\${APP_PRODUCT_FILENAME}"
    !endif
    !ifdef APP_PACKAGE_NAME
      RMDir /r "$APPDATA\${APP_PACKAGE_NAME}"
    !endif

    ${if} $installMode == "all"
      SetShellVarContext all
    ${endif}
  ${endIf}
!macroend

!macro customUnInstall
  ; Auto-updates retain reminders; a manual uninstall must not leave orphaned scheduled tasks.
  ${ifNot} ${isUpdated}
    nsExec::ExecToLog '"$SYSDIR\schtasks.exe" /Delete /TN "Commonwealth GA PvP Merc Fun" /F'
    Pop $R0
    nsExec::ExecToLog '"$SYSDIR\schtasks.exe" /Delete /TN "Commonwealth GA PvP Challenge Night" /F'
    Pop $R0
  ${endIf}
!macroend
