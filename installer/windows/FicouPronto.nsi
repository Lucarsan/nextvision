; Ficou Pronto - instalador Windows (NSIS 3, Unicode). Gerado por build.sh.
Unicode true
SetCompressor /SOLID lzma
SetCompressorDictSize 64
!include "MUI2.nsh"
!include "x64.nsh"
!include "LogicLib.nsh"
!include "WinVer.nsh"

!ifndef VERSION
  !define VERSION "0.0.0"
!endif
Name "Ficou Pronto"
OutFile "${OUTFILE}"
InstallDir "$PROGRAMFILES64\FicouPronto"
RequestExecutionLevel admin
BrandingText "Ficou Pronto ${VERSION}"
VIProductVersion "${VERSION}.0"
VIAddVersionKey "ProductName" "Ficou Pronto"
VIAddVersionKey "FileDescription" "Instalador do Ficou Pronto (cameras da loja)"
VIAddVersionKey "FileVersion" "${VERSION}"
VIAddVersionKey "ProductVersion" "${VERSION}"
VIAddVersionKey "CompanyName" "Ficou Pronto"
VIAddVersionKey "LegalCopyright" "Ficou Pronto"

!define PS '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe"'
!define UNINST_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\FicouPronto"

!define MUI_ABORTWARNING
!define MUI_WELCOMEPAGE_TITLE "Instalar o Ficou Pronto"
!define MUI_WELCOMEPAGE_TEXT "Este assistente instala o transmissor de video das cameras da loja.$\r$\n$\r$\nTenha em maos:$\r$\n  - o codigo de ativacao gerado na central;$\r$\n  - usuario e senha da camera.$\r$\n$\r$\nO video passa a iniciar sozinho com o Windows, antes do login."
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_INSTFILES
!define MUI_FINISHPAGE_TITLE "Arquivos instalados"
!define MUI_FINISHPAGE_TEXT "Agora vamos ativar este computador e configurar as cameras."
!define MUI_FINISHPAGE_RUN
!define MUI_FINISHPAGE_RUN_TEXT "Abrir o assistente de configuracao"
!define MUI_FINISHPAGE_RUN_FUNCTION RunWizard
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "PortugueseBR"

Function .onInit
  ${IfNot} ${RunningX64}
    MessageBox MB_ICONSTOP "O Ficou Pronto exige Windows 64 bits."
    Abort
  ${EndIf}
  ${IfNot} ${AtLeastWin10}
    MessageBox MB_ICONSTOP "O Ficou Pronto exige Windows 10 ou 11."
    Abort
  ${EndIf}
  SetRegView 64
FunctionEnd

Function RunWizard
  Exec '${PS} -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "$INSTDIR\agent\ficoupronto-setup.ps1"'
FunctionEnd

Section "Ficou Pronto" Main
  SetShellVarContext all
  ; Atualizacao: para os servicos para liberar os arquivos (configuracao e preservada).
  nsExec::Exec 'sc.exe stop FicouPronto.Agente'
  nsExec::Exec 'sc.exe stop FicouPronto.MediaMTX'
  nsExec::Exec 'sc.exe stop FicouPronto.Tunel'
  Sleep 3000
  SetOutPath "$INSTDIR\bin"
  File "${STAGE}\bin\ffmpeg.exe"
  File "${STAGE}\bin\mediamtx.exe"
  File "${STAGE}\bin\cloudflared.exe"
  File "${STAGE}\bin\WinSW-x64.exe"
  SetOutPath "$INSTDIR\agent"
  File "${STAGE}\agent\*.ps1"
  File "${STAGE}\agent\*.psm1"
  SetOutPath "$INSTDIR\licenses"
  File "${STAGE}\licenses\*.*"
  ; Scripts baixados ficam marcados como "da internet"; remove a marca dos nossos.
  nsExec::Exec '${PS} -NoProfile -Command "Get-ChildItem -LiteralPath $\'$INSTDIR\agent$\' | Unblock-File"'
  WriteUninstaller "$INSTDIR\Desinstalar.exe"
  CreateDirectory "$SMPROGRAMS\Ficou Pronto"
  CreateShortcut "$SMPROGRAMS\Ficou Pronto\Ficou Pronto - Manutencao.lnk" ${PS} '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "$INSTDIR\agent\ficoupronto-setup.ps1"' "$INSTDIR\bin\mediamtx.exe" 0
  CreateShortcut "$DESKTOP\Ficou Pronto - Manutencao.lnk" ${PS} '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "$INSTDIR\agent\ficoupronto-setup.ps1"' "$INSTDIR\bin\mediamtx.exe" 0
  CreateShortcut "$SMPROGRAMS\Ficou Pronto\Desinstalar.lnk" "$INSTDIR\Desinstalar.exe"
  WriteRegStr HKLM "${UNINST_KEY}" "DisplayName" "Ficou Pronto"
  WriteRegStr HKLM "${UNINST_KEY}" "DisplayVersion" "${VERSION}"
  WriteRegStr HKLM "${UNINST_KEY}" "Publisher" "Ficou Pronto"
  WriteRegStr HKLM "${UNINST_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKLM "${UNINST_KEY}" "UninstallString" '"$INSTDIR\Desinstalar.exe"'
  WriteRegStr HKLM "${UNINST_KEY}" "QuietUninstallString" '"$INSTDIR\Desinstalar.exe" /S'
  WriteRegDWORD HKLM "${UNINST_KEY}" "NoModify" 1
  WriteRegDWORD HKLM "${UNINST_KEY}" "NoRepair" 1
  ; Atualizacao de uma instalacao ja configurada: religa os servicos.
  ${If} ${FileExists} "$COMMONPROGRAMDATA\FicouPronto\config.json"
    nsExec::Exec 'sc.exe start FicouPronto.MediaMTX'
    nsExec::Exec 'sc.exe start FicouPronto.Tunel'
    nsExec::Exec 'sc.exe start FicouPronto.Agente'
  ${EndIf}
SectionEnd

Section "Uninstall"
  SetShellVarContext all
  SetRegView 64
  ${If} ${Silent}
    nsExec::Exec '${PS} -NoProfile -ExecutionPolicy Bypass -File "$INSTDIR\agent\ficoupronto-setup.ps1" -Mode uninstall -Quiet'
  ${Else}
    ExecWait '${PS} -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "$INSTDIR\agent\ficoupronto-setup.ps1" -Mode uninstall'
  ${EndIf}
  Delete "$DESKTOP\Ficou Pronto - Manutencao.lnk"
  RMDir /r "$SMPROGRAMS\Ficou Pronto"
  RMDir /r "$INSTDIR\bin"
  RMDir /r "$INSTDIR\agent"
  RMDir /r "$INSTDIR\licenses"
  Delete "$INSTDIR\Desinstalar.exe"
  RMDir "$INSTDIR"
  DeleteRegKey HKLM "${UNINST_KEY}"
SectionEnd
