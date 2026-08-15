' silent-run.vbs — runs a .bat through cmd.exe with a HIDDEN window, WAITS for it to
' finish, and propagates its real exit code so Task Scheduler's LastTaskResult stays
' meaningful.
'
' WHY THIS WRAPPER EXISTS: a scheduled task under an Interactive principal that runs a
' .bat DIRECTLY flashes a console window on every tick. At a 3-minute interval that is a
' window every 3 minutes, all day. (This was tried and reverted once — never put either
' task on a bare cmd.exe.)
'
' The three details that matter:
'   %ComSpec% /d /s /c   — /d skips AutoRun commands, /s handles the doubled quoting
'   objShell.Run(cmd, 0, True) — 0 = hidden, True = WAIT (without it every run reports
'                                success instantly and LastTaskResult becomes meaningless)
'   WScript.Quit(exitCode)     — propagate the real result
'
' Usage: wscript.exe //B silent-run.vbs "C:\path\to\script.bat"

If WScript.Arguments.Count < 1 Then
  WScript.Quit(2)
End If

Set objShell = CreateObject("WScript.Shell")
batPath = WScript.Arguments(0)
cmd = "%ComSpec% /d /s /c " & Chr(34) & Chr(34) & batPath & Chr(34) & Chr(34)
exitCode = objShell.Run(cmd, 0, True)
WScript.Quit(exitCode)
