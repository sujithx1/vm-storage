# VM Storage Manager

A local web app (Bun + Hono backend, React + Vite frontend) that connects to your VMs over SSH, shows where disk space goes, and cleans it up.

## Project layout

Two independent projects, each with its own `package.json`:

```
backend/    Bun + Hono API server (SSH, scanning, cleanup, security)
frontend/   React + Vite UI
```

## Run

Build the UI once (and again after UI changes):

```bash
cd frontend
bun install
bun run build
```

Start the server:

```bash
cd backend
bun install
bun start
```

The backend serves the UI from `frontend/dist` on http://localhost:4848 and opens a one-time sign-in link in your browser.
The link is also printed in the terminal. Use `PORT=xxxx bun start` to change the port, or `FRONTEND_DIST=/path/to/dist` to serve a build from elsewhere.

## Development

Run each project in its own terminal:

```bash
cd backend && bun run dev      # API with auto-restart on :4848
```

```bash
cd frontend && bun run dev     # Vite with hot reload on :5173, proxies /api to the backend
```

Open the sign-in link the backend prints once, then use http://localhost:5173.

## Features

- **Disks**: every mounted filesystem with usage. Click one to explore it.
- **Folder tree with sizes**: scan a disk once (`du`, streamed with live progress). After that every folder's size is in memory, so expanding and browsing is instant. Deletes update the sizes without a rescan.
- **Contents panel**: folders and files of the selected folder, biggest first, with % of the folder. Large folders are virtualized, so 100k-file folders stay smooth.
- **Largest files**: the biggest files under any folder.
- **Root-owned files**: Docker data, container volumes and many logs are only readable by root. Turn on **Use sudo** (it asks for the sudo password if the VM needs one) and rescan. Folders the scan could not fully read show a lock icon, so a too-small size is never shown silently.
- **Actions**: Delete, Empty (clear a live log in place), Edit (text files up to 2 MB, ⌘S saves), Download.
- **Download**: saves a file, or a whole folder (like a project) as `name.tar.gz`, to your computer's Downloads folder. Folders are compressed on the VM and streamed, so large ones never sit in memory. Downloads run as the SSH user without sudo, so only files that user can read are offered; anything inside a folder it cannot read is left out of the archive.
- **Cleanup**:
  - *Safe*: apt downloads, journal logs older than 7 days, old rotated logs, pip/npm/yarn/bun/go caches, stale temp files, crash dumps, old snap revisions, Docker build cache.
  - *Force*: shrink the journal to 50 MB, all rotated logs, empty live logs over 100 MB, all temp files, entire ~/.cache, `docker system prune -a`, unused Docker volumes, `apt autoremove`. Each shows a warning, and running them requires typing `FORCE`.

## Security

- **Local only**: the server listens on 127.0.0.1.
- **Sign-in token**: a random secret in `~/.config/vm-storage/token` (mode 600). The sign-in link turns it into an HttpOnly, SameSite=Strict cookie. Other programs or websites without it get "locked".
- **Browser attacks blocked**: Host and Origin checks stop DNS rebinding and cross-site requests. Writes need a custom header. A strict Content-Security-Policy is set.
- **SSH host keys are verified** against `~/.ssh/known_hosts` and `~/.config/vm-storage/known_hosts`. On a first connection you confirm the fingerprint. A changed key is refused before any password or key is sent.
- **Credentials**: passwords, passphrases and pasted keys are never written to disk. Recent connections remember only host, port, user and key path. Prefer key files or ssh-agent over passwords. Hosts from `~/.ssh/config` are listed for one-click use.
- **No arbitrary commands**: every cleanup is a fixed command defined on the server. The page only sends item ids. Paths are shell-quoted. Top-level system folders and whole mounted disks cannot be deleted.
- **sudo password**: if sudo on the VM needs a password, the app asks for it once per connection. The app checks it, keeps it only in memory, and passes it to `sudo -S` on stdin, so it never appears in the VM's process list or shell history. It is gone when you disconnect.
- **Idle SSH sessions** close after 30 minutes.

To revoke access for all browsers, delete `~/.config/vm-storage/token` and restart.
