' run-hidden.vbs - start a command with NO console window at all.
'
' WHY THIS EXISTS (2026-09-18, second round: the flash survived -WindowStyle Hidden):
'
'   powershell.exe -WindowStyle Hidden does NOT prevent the console window from
'   being created. The OS creates the console host BEFORE any PowerShell code
'   runs, and PowerShell only calls ShowWindow(SW_HIDE) once it is already up.
'   On a fast machine that is a visible flash on every single trigger. No
'   -WindowStyle / -NonInteractive combination can avoid it, because the window
'   exists before the flag is ever read.
'
'   wscript.exe is a GUI-subsystem binary. It never attaches a console, so
'   there is nothing to flash. WshShell.Run(cmd, 0, True) then hands
'   STARTUPINFO.wShowWindow = SW_HIDE to CreateProcess, so the child's console
'   is created hidden from its very first frame instead of hidden afterwards.
'
' HOW TO WIRE IT UP (Task Scheduler action - this is the ONLY supported shape):
'   Execute    = wscript.exe
'   Arguments  = "<full path to this file>" "<full command line to run>"
'   Example    = wscript.exe "C:\harvests\harvests-engine\scripts\run-hidden.vbs" "C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe -ExecutionPolicy Bypass -File C:\harvests\harvests-engine\scripts\vps-bot-autosync.ps1"
'
'   scripts\fix-popup-windows.ps1 -UseWrapper builds exactly that string for you.
'
' EXIT CODES
'   87 (ERROR_INVALID_PARAMETER) = no command line argument was passed.
'   The child's own exit code is propagated, because bWaitOnReturn is True -
'   so Get-ScheduledTaskInfo LastTaskResult keeps its meaning.
'
' DELIBERATELY SILENT ON ERROR: wscript.exe has no stdout/stderr, and
' WScript.Echo would pop a MODAL DIALOG BOX - which would be a far worse popup
' than the one this file exists to remove. A misconfigured task therefore
' announces itself through LastTaskResult = 87 instead of through a dialog.
Option Explicit
Dim sh, rc
If WScript.Arguments.Count < 1 Then WScript.Quit 87
Set sh = CreateObject("WScript.Shell")
rc = sh.Run(WScript.Arguments(0), 0, True)
WScript.Quit rc
