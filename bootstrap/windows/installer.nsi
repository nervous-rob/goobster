; Goobster Windows installer (documentation/windows_install.md, issue #331).
;
; Built by scripts/package-bootstrap-win32.js, which writes the build header
; (BUILD_HEADER) this script includes: VERSION, VERSION_NUMERIC, PAYLOAD_DIGEST,
; BUILD, SIGNED, LABEL, OUTFILE, ICON_FILE and the sorted payload file list
; (BUILD_PAYLOAD_FILES). This file holds every decision that does not change from
; one build to the next.
;
; The installer never writes to the machine: it unpacks the embedded payload under
; the person's own profile (RequestExecutionLevel user), then hands over to
; apps/manager/bootstrap/win32.js, which verifies the payload digest and runs the
; same install engine as the Linux .run. Anything that needs administrator rights
; (the Windows service) is asked for by the manager through UAC, one operation at a time.
;
;   goobster-<version>-win32-x64[-dev].exe                          the install wizard in the browser
;   goobster-<version>-win32-x64[-dev].exe /S /ANSWERS=<file>       unattended install from an answers file
;   ... /BASE=<dir>                                                 install under <dir> instead of %LOCALAPPDATA%\Goobster
;
; Silent runs are asynchronous unless started with `start /wait` (cmd) or
; `Start-Process -Wait -PassThru` (PowerShell); the exit code is the manager's
; (0 installed, 1 failed, 2 usage, 3 already installed, 4 payload mismatch, 5 applied
; with a step to finish by hand).

Unicode true
ManifestDPIAware true
SetCompressor /SOLID lzma
SetCompressorDictSize 32
SetDateSave off
SetOverwrite on
CRCCheck on
RequestExecutionLevel user
ShowInstDetails show
ShowUninstDetails show

!ifndef BUILD_HEADER
    !error "BUILD_HEADER is not defined: build with scripts/package-bootstrap-win32.js"
!endif
!include "${BUILD_HEADER}"

!include "LogicLib.nsh"
!include "FileFunc.nsh"
!insertmacro GetParameters
!insertmacro GetOptions
!insertmacro GetParent
!insertmacro un.GetParent

!define UNINSTALL_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\Goobster"

Name "Goobster ${VERSION}"
OutFile "${OUTFILE}"
Icon "${ICON_FILE}"
UninstallIcon "${ICON_FILE}"
InstallDir "$LOCALAPPDATA\Goobster"
BrandingText "Goobster ${VERSION} - ${LABEL}"
Caption "Goobster ${VERSION} setup"
UninstallCaption "Remove Goobster"

VIProductVersion "${VERSION_NUMERIC}"
VIFileVersion "${VERSION_NUMERIC}"
VIAddVersionKey "ProductName" "Goobster"
VIAddVersionKey "FileDescription" "Goobster installer"
VIAddVersionKey "ProductVersion" "${VERSION}"
VIAddVersionKey "FileVersion" "${VERSION}"
VIAddVersionKey "CompanyName" "Goobster"
VIAddVersionKey "LegalCopyright" "Goobster contributors"
VIAddVersionKey "Comments" "${LABEL}"

Page instfiles
UninstPage uninstConfirm
UninstPage instfiles

Var AnswersFile
Var BaseDir
Var Stage
Var Command
Var ExitCode
Var Registered
Var ScanText
Var ScanIndex
Var ScanLength
Var ScanChar
Var ScanBad
Var CodeRoot

; Sets $ScanBad to 1 when $ScanText holds a character that could change how a
; command line or cmd.exe reads it.
!macro DefineScanForbidden PREFIX
Function ${PREFIX}ScanForbidden
    StrCpy $ScanBad 0
    StrLen $ScanLength $ScanText
    StrCpy $ScanIndex 0
    ${While} $ScanIndex < $ScanLength
        StrCpy $ScanChar $ScanText 1 $ScanIndex
        ${If} $ScanChar == '"'
        ${OrIf} $ScanChar == "%"
        ${OrIf} $ScanChar == "&"
        ${OrIf} $ScanChar == "|"
        ${OrIf} $ScanChar == "<"
        ${OrIf} $ScanChar == ">"
        ${OrIf} $ScanChar == "^"
        ${OrIf} $ScanChar == "!"
            StrCpy $ScanBad 1
            Return
        ${EndIf}
        IntOp $ScanIndex $ScanIndex + 1
    ${EndWhile}
FunctionEnd
!macroend
!insertmacro DefineScanForbidden ""
!insertmacro DefineScanForbidden "un."

Function .onInit
    ${GetParameters} $0
    ClearErrors
    ${GetOptions} $0 "/ANSWERS=" $AnswersFile
    ${If} ${Errors}
        StrCpy $AnswersFile ""
    ${EndIf}
    ClearErrors
    ${GetOptions} $0 "/BASE=" $BaseDir
    ${If} ${Errors}
        StrCpy $BaseDir ""
    ${EndIf}

    ${If} $AnswersFile != ""
        StrCpy $ScanText $AnswersFile
        Call ScanForbidden
        ${If} $ScanBad == 1
            SetErrorLevel 2
            Abort "/ANSWERS holds a character this installer does not pass on."
        ${EndIf}
        ${IfNot} ${FileExists} "$AnswersFile"
            SetErrorLevel 2
            Abort "The answers file does not exist."
        ${EndIf}
    ${EndIf}

    ${If} $BaseDir != ""
        StrCpy $ScanText $BaseDir
        Call ScanForbidden
        StrCpy $1 $BaseDir 2 1
        ${If} $ScanBad == 1
        ${OrIf} $1 != ":\"
            SetErrorLevel 2
            Abort "/BASE must be a full drive path such as D:\Goobster, without quotes or shell characters."
        ${EndIf}
        StrCpy $INSTDIR $BaseDir
    ${EndIf}

    ${If} ${Silent}
    ${AndIf} $AnswersFile == ""
        SetErrorLevel 2
        Abort "A silent install needs /ANSWERS=<file>."
    ${EndIf}
FunctionEnd

Section "Install"
    StrCpy $Stage "$INSTDIR\stage\${VERSION}"
    DetailPrint "${LABEL}"
    DetailPrint "Unpacking Goobster ${VERSION} to $Stage"
    RMDir /r "$Stage"
    ClearErrors
    CreateDirectory "$Stage"
    ${If} ${Errors}
        SetErrorLevel 1
        Abort "Could not create the staging folder."
    ${EndIf}

    !insertmacro BUILD_PAYLOAD_FILES

    CreateDirectory "$INSTDIR\uninstall"
    WriteUninstaller "$INSTDIR\uninstall\uninstall.exe"

    StrCpy $Command '"$Stage\payload\runtime\node.exe" "$Stage\payload\app\apps\manager\bootstrap\win32.js"'
    StrCpy $Command '$Command --payload "$Stage\payload" --payload-digest ${PAYLOAD_DIGEST} --build ${BUILD} --signed ${SIGNED}'
    StrCpy $Command '$Command --installer "$EXEPATH" --uninstaller "$INSTDIR\uninstall\uninstall.exe"'
    ${If} $BaseDir != ""
        StrCpy $Command '$Command --base "$BaseDir"'
    ${EndIf}

    ${If} $AnswersFile != ""
        StrCpy $Command '$Command --headless --answers "$AnswersFile"'
        DetailPrint "Installing from the answers file"
        ExecWait '$Command' $ExitCode
        RMDir /r "$Stage"
        RMDir "$INSTDIR\stage"
        ReadRegStr $Registered HKCU "${UNINSTALL_KEY}" "InstallLocation"
        ${If} $Registered == ""
            Delete "$INSTDIR\uninstall\uninstall.exe"
            RMDir "$INSTDIR\uninstall"
        ${EndIf}
        SetErrorLevel $ExitCode
        ${If} $ExitCode != 0
        ${AndIf} $ExitCode != 5
            Abort "The install did not finish (exit $ExitCode)."
        ${EndIf}
    ${Else}
        StrCpy $Command '$Command --open-browser'
        DetailPrint "Starting the install wizard; it opens in your browser."
        Exec '$Command'
    ${EndIf}
SectionEnd

Function un.onInit
    ReadRegStr $CodeRoot HKCU "${UNINSTALL_KEY}" "InstallLocation"
    ${If} $CodeRoot == ""
        SetErrorLevel 1
        Abort "Goobster is not registered for this account; nothing to remove."
    ${EndIf}
    StrCpy $ScanText $CodeRoot
    Call un.ScanForbidden
    ${If} $ScanBad == 1
        SetErrorLevel 1
        Abort "The registered install location holds a character this uninstaller does not pass on."
    ${EndIf}
    ${IfNot} ${FileExists} "$CodeRoot\goobster-manager.cmd"
        SetErrorLevel 1
        Abort "The launcher is missing from the install location; use the manual removal steps in the documentation."
    ${EndIf}
FunctionEnd

; Removes the code and the service through the installation's own launcher and
; keeps every byte of data: the answers file says keepData and nothing else.
; Deleting data stays a deliberate act with a typed confirmation
; (`goobster-manager uninstall --delete-data --confirm <installationId>`).
Section "Uninstall"
    InitPluginsDir
    ClearErrors
    FileOpen $0 "$PLUGINSDIR\uninstall-answers.json" w
    ${If} ${Errors}
        SetErrorLevel 1
        Abort "Could not write the uninstall answers."
    ${EndIf}
    FileWrite $0 '{"keepData":true}'
    FileClose $0

    DetailPrint "Removing the Goobster code and service; your data is kept."
    ExecWait '"$SYSDIR\cmd.exe" /d /s /c ""$CodeRoot\goobster-manager.cmd" uninstall --answers "$PLUGINSDIR\uninstall-answers.json" --yes"' $ExitCode
    ${If} $ExitCode != 0
        SetErrorLevel $ExitCode
        Abort "The uninstall did not finish (exit $ExitCode). Nothing else was removed."
    ${EndIf}

    Delete "$CodeRoot\goobster-manager.cmd"
    RMDir "$CodeRoot"
    DeleteRegKey HKCU "${UNINSTALL_KEY}"
    ${un.GetParent} "$INSTDIR" $0
    ${If} $0 != ""
        RMDir /r "$0\stage"
    ${EndIf}
    Delete "$INSTDIR\uninstall.exe"
    RMDir "$INSTDIR"
SectionEnd
