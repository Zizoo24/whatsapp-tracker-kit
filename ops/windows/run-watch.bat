@echo off
REM Extraction lane entry point. Scheduled every ~3 minutes.
REM Idle ticks cost nothing and log nothing.
REM
REM EDIT THIS PATH to your install directory.
cd /d C:\path\to\whatsapp-tracker-kit

REM Long-lived headless auth. A normal subscription login token expires roughly daily and
REM a headless subprocess CANNOT refresh it -> 401 -> extraction silently stops while
REM everything else looks healthy. Get a long-lived token (`claude setup-token`) and put it
REM on ONE line in agent-token.env (gitignored).
REM
REM GOTCHA THAT COST AN HOUR: a stray LEADING SPACE in that file still yields 401. Verify
REM with `head -c 11 agent-token.env` and strip whitespace before blaming the token.
if exist agent-token.env set /p CLAUDE_CODE_OAUTH_TOKEN=<agent-token.env

REM PREFLIGHT: a syntax-broken watcher once crashed 3 ticks in total silence. `node --check`
REM catches it BEFORE running and alerts ONCE per breakage streak (the marker is cleared on
REM the first healthy preflight, so a fixed-then-rebroken file alerts again).
REM
REM The alert is sent here, from the .bat, because a file that will not parse cannot alert
REM about itself. Set TRACKER_ALERT_NUMBER below to your alert recipient (digits, no +).
set TRACKER_ALERT_NUMBER=
node --check scripts\tracker-watch.cjs >> watch.log 2>&1
if errorlevel 1 (
  if not exist .alert-watch-syntax (
    if defined TRACKER_ALERT_NUMBER (
      curl -s --max-time 15 -X POST http://127.0.0.1:8080/api/send -H "Content-Type: application/json" -d "{\"Recipient\":\"%TRACKER_ALERT_NUMBER%\",\"Message\":\"Tracker alert: the watcher has a SYNTAX ERROR - all ticks halted until it is fixed. Check watch.log.\"}" >nul 2>&1
    )
    echo x > .alert-watch-syntax
  )
  exit /b 1
)
if exist .alert-watch-syntax del .alert-watch-syntax

node scripts\tracker-watch.cjs >> watch.log 2>&1
