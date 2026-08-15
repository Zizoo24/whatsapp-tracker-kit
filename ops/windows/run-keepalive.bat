@echo off
REM TRANSPORT keepalive lane. Scheduled every ~5 minutes AND at logon.
REM Keeps the bridge process alive and survives reboots. Deliberately does NOT extract,
REM reason, or write records — semantic authority belongs to the extraction lane and the
REM agent lane. See scripts/bridge-keepalive.cjs for the 66-hour outage that created it.
REM
REM EDIT THIS PATH to your install directory.
cd /d C:\path\to\whatsapp-tracker-kit

REM PREFLIGHT: a syntax-broken script fails silently on a schedule. No alert here on
REM purpose — the alert path posts THROUGH the bridge, which is exactly what may be down.
node --check scripts\bridge-keepalive.cjs >> bridge-keepalive.log 2>&1
if errorlevel 1 exit /b 1

node scripts\bridge-keepalive.cjs
