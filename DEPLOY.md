# Deploying Plecks by hand

How to get Plecks onto the TV and keep the channel server running without any help.
There are two separate pieces:

| Piece | What it is | Where it runs |
| --- | --- | --- |
| **TV app** (`app/`) | The Plex client you use with the remote | Installed on the Samsung TV from a Mac or Linux machine |
| **Channel server** (`channels/`) | Holds the virtual channels and their schedules, and serves the admin page | The machine that runs Plex Media Server |

The TV app works without the channel server, but the Guide tab and channels don't.

Everything personal (TV address, certificate password, Plex token) lives in `.env` or
your Tizen certificate folder. Both are gitignored, so they never go into this repo.
Keep it that way.

---

## Part 1: install the TV app

### What you need

- A Mac or a Linux machine. The scripts don't run on Windows.
- The TV and that machine on the same network, with the TV turned on.
- `git`, `curl` and `bash`, which are already on a Mac.
- About 2 GB of disk space for the Tizen Studio command-line tools. The setup script installs them.

### 1. Get the code

```bash
git clone https://github.com/FuzzyDunlop27/samsucks.git
cd samsucks
```

Already cloned? Run `git pull` inside the folder instead.

### 2. Match the TV's Tizen version

`app/config.xml` has `required_version="6.5"`, which fits 2022 TVs. Find your TV's year
under **Settings > Support > About This TV** (or from the model code on the back).

| TV year | Tizen | `required_version` |
| --- | --- | --- |
| 2020 | 5.5 | `5.5` |
| 2021 | 6.0 | `6.0` |
| 2022 | 6.5 | `6.5` (default) |
| 2023 and later | 7.0+ | `6.5` works |

If your TV is older than the version in the file, lower the number or the install is refused.

### 3. Turn on Developer Mode on the TV (one time)

1. Press **Home** and open **Apps**.
2. On the Apps screen, type **1 2 3 4 5** on the remote. On a remote with no number keys,
   use the **123** button for the on-screen keypad. If nothing happens, type faster.
3. Set **Developer mode** to **On**, and enter the IP address of the Mac or Linux machine.
   The setup script prints this address if you don't know it.
4. Choose **OK**, then restart the TV: hold **Power** until it turns off and back on.

If that machine's IP address changes later, repeat this step with the new address.

### 4. Run setup (one time, safe to re-run)

```bash
./scripts/setup.sh
```

It does the following:

- installs the Tizen Studio CLI to `~/tizen-studio`
- finds the TV on your network and checks that Developer Mode is on
- creates a signing certificate profile
- writes everything to `.env`

The password it generates for the certificate is saved only in `.env`.

### 5. Build and install

```bash
./scripts/deploy.sh
```

This copies `app/` to `build/`, then packages, signs, installs and launches it on the TV.
Other options:

```bash
./scripts/deploy.sh --build-only   # just build, no TV needed
./scripts/deploy.sh --no-run       # install without launching
```

The app ID in `config.xml` (`SamSucks01.samsucks`) has stayed the same through the rename.
That way a deploy replaces the existing app instead of adding a second copy. Don't
change it, or you'll end up with two apps and have to sign in again.

### 6. Sign in (first install only)

Plecks shows a code on the TV. Go to <https://plex.tv/link> on your phone and enter it.

To pin the app to the TV's home bar, highlight **Plecks**, hold **OK**, and choose **Move**
or **Add to Home**.

### Updating the TV app later

```bash
cd samsucks
git pull
./scripts/deploy.sh
```

The new name, icon and code only reach the TV through a deploy. Bump `version=` in
`app/config.xml` when you change something, so you can tell which build is installed.
The version is shown at the bottom of Settings.

### When the TV app install goes wrong

| Problem | Fix |
| --- | --- |
| "No .env yet" | Run `./scripts/setup.sh` first. |
| "No Samsung TV found" | The TV is off, or it's on a different network or VLAN. Turn it on, or put its address in `.env` as `TV_IP=` and run setup again. |
| "Can't reach the TV" / connection refused | Restart the TV. Check that Developer Mode still has this machine's **current** IP address, then run setup again. |
| Install refused for version | `required_version` in `app/config.xml` is higher than the TV's Tizen version. Lower it (see step 2). |
| Install refused for the certificate | Some TVs want a Samsung certificate instead of the plain author certificate. In Tizen Studio's Certificate Manager, create a Samsung certificate. This needs a Samsung account and the TV's DUID. Then set `TIZEN_SIGN_PROFILE=` in `.env` to that profile's name. |
| App disappeared after a TV update | Firmware updates can remove sideloaded apps. Run `./scripts/deploy.sh` again. |
| Rebuilt on a new computer | It has no certificate. Run `./scripts/setup.sh`. A differently signed build may need you to uninstall the old app on the TV first. |

---

## Part 2: run the channel server

It runs next to Plex Media Server and needs **Node.js 18 or newer**
(<https://nodejs.org>, LTS version). It has no dependencies, so `npm install` isn't needed.

### Start it

From the repo folder on the Plex machine:

```bash
node channels/server.mjs
```

It prints `Plecks channels on http://localhost:32500`. Then open the admin page in a
browser on any device on your home network:

```
http://<plex-machine-ip>:32500
```

There you can create channels, add shows, movies, collections or playlists, and see
what's coming up. The **Browse all** tab under **Add content** lists the whole library,
with Movies, TV shows and Kids filters.

The TV finds the server on its own: it uses the Plex server's address on port 32500.

### Plex sign-in

On the Plex machine itself, the server reads Plex's own token (from the Windows registry,
or from Plex's `Preferences.xml` on Linux or macOS), so there's nothing to set up.
If it says `token missing`, or it runs on a different machine than Plex, set the
token in the environment. Never put it in a file in this repo.

```bash
PLEX_TOKEN=<your token> PLEX_URL=http://<plex-ip>:32400 node channels/server.mjs
```

On Windows PowerShell:

```powershell
$env:PLEX_TOKEN = '<your token>'; node channels/server.mjs
```

Optional settings, all read from environment variables:

| Variable | Default | What it does |
| --- | --- | --- |
| `PORT` | `32500` | Port for the API and admin page. The TV expects 32500. |
| `PLEX_URL` | `http://127.0.0.1:32400` | Where Plex Media Server is. |
| `PLEX_TOKEN` | auto-detected | Plex token, if auto-detection doesn't work. |
| `DATA_DIR` | `channels/data` | Where channels and schedules are saved. |

### Windows firewall

The first time it runs, Windows may ask whether to allow Node.js on networks. Allow it
on **Private** networks. If the TV says it can't reach the channel server, add an inbound
rule for TCP port 32500 (Private profile). Run this in an **admin** PowerShell:

```powershell
New-NetFirewallRule -DisplayName "Plecks channels" -Direction Inbound -Protocol TCP -LocalPort 32500 -Action Allow -Profile Private
```

### Keep it running after a reboot (Windows)

1. Open **Task Scheduler** and choose **Create Task**.
2. **General:** name it `Plecks channels`, and pick **Run whether user is logged on or not**.
3. **Triggers:** **New > At startup**.
4. **Actions:** **New > Start a program**.
   - Program: `C:\Program Files\nodejs\node.exe`
   - Arguments: `channels\server.mjs`
   - Start in: the full path to your `samsucks` folder
5. **Settings:** turn off **Stop the task if it runs longer than**.
6. Save. Windows asks for your account password; that stays in Windows.

On Linux, a systemd service that runs `node channels/server.mjs` with
`WorkingDirectory=` set to the repo does the same job.

### Updating the channel server

```bash
git pull
```

Then restart it: stop it with Ctrl+C and start it again, or restart the scheduled task.
To have it restart on its own whenever the code changes, run it as
`node --watch channels/server.mjs`.

### Back up your channels

Channel setups and schedules are stored in `channels/data/` (`channels.json`,
`schedules.json`). That folder is gitignored, so `git pull` never touches it. It also
means GitHub has no copy. Copy the folder somewhere safe now and then, and copy it back
after a fresh clone.

---

## Regenerating the branding

You only need this if you change the logo.

- `scripts/make-plecks-brand.ps1` (Windows PowerShell): header mark, wordmark, splash
  screen and login art. Run `& ./scripts/make-plecks-brand.ps1` from the repo folder.
- `scripts/make-plecks-icon.py` (Python 3 with Pillow and fontTools): the TV launcher
  icons with the name under the mark. Run `python3 scripts/make-plecks-icon.py`.

Deploy the TV app again afterwards so the TV picks up the new images.
