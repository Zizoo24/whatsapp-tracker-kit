# Linux / systemd scheduling

The same two lanes as Windows, on systemd timers. Install as **user units** so the model
CLI runs with the user's own authentication — the same reason the Windows tasks use
`InteractiveToken`.

```bash
mkdir -p ~/.config/systemd/user
cp ops/linux/*.service ops/linux/*.timer ~/.config/systemd/user/

# Point the units at your install directory
sed -i "s|/path/to/whatsapp-tracker-kit|$HOME/whatsapp-tracker-kit|g" ~/.config/systemd/user/tracker-*.service

systemctl --user daemon-reload
systemctl --user enable --now tracker-watch.timer tracker-keepalive.timer

# Survive logout / run at boot without a login session
sudo loginctl enable-linger "$USER"
```

`enable-linger` is the Linux equivalent of the Windows logon trigger, and it matters for
the same reason: **repetition alone never covers a boot.** Without it the timers stop when
the session ends and nothing restarts them.

## Verify

```bash
systemctl --user list-timers 'tracker-*'
journalctl --user -u tracker-watch.service -n 50 --no-pager
systemctl --user status tracker-keepalive.service
```

## Notes

- `Persistent=true` makes a timer fire on resume if its window was missed while suspended.
  Without it, a laptop that slept through several intervals simply skips them.
- `bridge-supervisor.cjs` uses `pgrep`/`pkill` on non-Windows — make sure `procps` is
  installed, or `isAlive()` throws and the tick aborts.
- The bridge itself is not a systemd unit here on purpose: the keepalive owns its
  lifecycle, including the restart budget and escalation. Running it under `Restart=always`
  **as well** gives you two supervisors fighting, and the budget becomes fiction.
