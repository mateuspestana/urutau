# Urutau on Windows (experimental)

[Português](windows.md) · **English**

Docker on Windows does not give containers access to USB devices. For that reason, Urutau runs inside **WSL2** (the Windows Subsystem for Linux), and the receiver is passed to Linux by **[usbipd-win](https://github.com/dorssel/usbipd-win)**. From that point on, the installation is identical to Linux.

> This setup has not yet been validated with a receiver on a real Windows machine. Test reports are welcome in the [issues](https://github.com/mateuspestana/urutau/issues).

## Requirements

- Windows 10 (21H2 or later) or Windows 11.
- WSL2 with Ubuntu: in PowerShell as administrator, run `wsl --install -d Ubuntu`, restart the computer and open Ubuntu once to create the user.
- Docker Engine **installed inside the WSL Ubuntu**, which is the most direct way for the receiver to reach the containers:
  ```bash
  # in the Ubuntu terminal
  echo -e "[boot]\nsystemd=true" | sudo tee /etc/wsl.conf
  # in PowerShell: wsl --shutdown; then open Ubuntu again
  curl -fsSL https://get.docker.com | sh
  sudo usermod -aG docker $USER   # close and reopen the terminal
  ```
  Docker Desktop with WSL integration enabled may work, but has not been verified.

## Automatic installation

Download [`install-windows.ps1`](../install-windows.ps1) and run it in **PowerShell as administrator**:

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\install-windows.ps1
```

The script installs usbipd-win, finds the receiver, attaches it to WSL and runs `install.sh` inside Ubuntu, in the Windows display language (or the one given with `-Lang pt|en|es|fr|ru`). When it finishes, open **http://localhost:3090** in your Windows browser.

## Manual installation

```powershell
winget install --exact --id dorssel.usbipd-win
usbipd list                                    # note the BUSID of "RTL2838" (0bda:2838)
usbipd bind --busid 2-3 --force                # replace 2-3 with the BUSID you found
usbipd attach --wsl --busid 2-3 --auto-attach  # keep this window open
```

```bash
# in the WSL Ubuntu
lsusb | grep -i rtl                            # the receiver should appear here
git clone https://github.com/mateuspestana/urutau.git && cd urutau && ./install.sh
```

## Notes

- The `usbipd attach --auto-attach` window must stay open: it reattaches the receiver when it is unplugged or when WSL restarts. After restarting Windows, run `attach` again; `bind` is persistent.
- While the receiver is attached to WSL, Windows programs (SDR#, SDR++) cannot see it. To give it back to Windows: `usbipd detach --busid 2-3`.
- The `--force` option of `bind` detaches the receiver from the Windows TV driver. To undo: `usbipd unbind --busid 2-3`.
- The panel is served on `localhost`, because Windows forwards WSL ports automatically.
