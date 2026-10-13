# Matterbridge Frigate Plugin

[![Buy me a coffee](https://img.shields.io/badge/Buy%20me%20a%20coffee-support-FFDD00?logo=buy-me-a-coffee&logoColor=black)](https://buymeacoffee.com/6sjde6vkzl) [![Discord](https://img.shields.io/badge/Discord-Matterbridge-5865F2?logo=discord&logoColor=white)](https://discord.gg/F2GupTjQdu)

A [Matterbridge](https://github.com/Luligu/matterbridge) plugin that brings the cameras of your [Frigate](https://frigate.video) NVR to Matter: live video and audio, Frigate's detections as motion, snapshots and cloud clip recording. Made for SmartThings, the first Matter controller with camera support. **No ffmpeg needed**: video is passed through from Frigate's restream, and the small audio and picture codecs are built in.

> This plugin is new. Please report what works and what doesn't in an [issue](https://github.com/tammeryousef1006/matterbridge-frigate/issues), with the Matterbridge log.

## Features

- **Finds Frigate by itself** on this machine or your network (ports 5000 and 8971), or uses the address you enter.
- **Every Frigate camera is added automatically**, each as its own Matter camera with its own QR code.
- **Live view** straight from Frigate's go2rtc restream: no re-encoding, so the picture starts quickly and stays sharp.
- **Live audio** (Opus) and **clip audio** (AAC), made from what your camera sends.
- **Detections as motion:** person, car, dog... from Frigate start a clip and show on the controller's timeline. Choose which objects count, and in which Frigate zones.
- **Snapshots** for the camera tile, from Frigate.
- **Cloud clips** (Matter Push AV) with a few seconds from before the detection.
- **A setup page** in Matterbridge (globe icon): Frigate connection, preview, sound check, detections and the pairing QR code of each camera.
- Works with Frigate's open port 5000 or its login port 8971 (any Frigate user), with or without MQTT.

## Prerequisites

- **Frigate 0.14 or later**, with its cameras in **go2rtc** (the [restream](https://docs.frigate.video/configuration/restream) setup in the Frigate config). Most Frigate setups already have it.
- **H.264 video** in go2rtc. H.265-only cameras need an H.264 stream added (see [Troubleshooting](#troubleshooting)).
- A **Matter controller with camera support**: SmartThings today. Apple Home, Google Home and others show Matter cameras once they support them.
- Matterbridge **3.10 or later** (the installers below install it for you).

## Installation

Pick one of these. **Already have Frigate running? Option 1 or 2 is all you need:** one command installs Matterbridge with this plugin, and the plugin then finds Frigate on its own.

The one-line installers work on Debian, Ubuntu, Raspberry Pi OS, Fedora, RHEL-like systems, openSUSE, Arch and Alpine, on a PC, a Raspberry Pi, a VM or a Proxmox LXC. They can run on the same machine as Frigate or on another one in the same network.

> **curl or wget missing?** Minimal systems (such as Proxmox LXC templates) often have neither. Install one first, e.g. `sudo apt update && sudo apt install -y curl` (Debian/Ubuntu) or `sudo dnf install -y curl` (Fedora/RHEL), or the same with `wget`.
>
> **Logged in as root** (usual in an LXC)? Leave out `sudo` in the commands below.

### Option 1: Standalone (recommended)

Installs Node.js (if missing or older than 20), Matterbridge and the Frigate plugin, and runs Matterbridge as a service that starts on boot.

```bash
curl -fsSL https://raw.githubusercontent.com/tammeryousef1006/matterbridge-frigate/main/install.sh | sudo bash
```

or with wget:

```bash
wget -qO- https://raw.githubusercontent.com/tammeryousef1006/matterbridge-frigate/main/install.sh | sudo bash
```

- Node.js comes from the official NodeSource repository, so `apt upgrade` (or `dnf upgrade`) keeps it up to date without breaking Matterbridge.
- Matterbridge runs as its own `matterbridge` user; its data is in `/var/lib/matterbridge`.
- Already ran the installer of another of my plugins ([eWeLink](https://github.com/tammeryousef1006/matterbridge-ewelink), [TTLock](https://github.com/tammeryousef1006/matterbridge-ttlock), [Tapo](https://github.com/tammeryousef1006/matterbridge-tapo))? Run this one too: it finds that Matterbridge and just adds the Frigate plugin to it. Nothing else changes.
- Matterbridge installed some other way? The installer leaves it alone and only adds the plugin.
- With a firewall (firewalld or ufw) switched on, the installer also opens the ports the cameras need: 5541–5560 (one per camera) and UDP 50000–50100 (live view).

### Option 2: Docker

Runs Matterbridge in the official [`luligu/matterbridge`](https://hub.docker.com/r/luligu/matterbridge) Docker image with the Frigate plugin. A good fit when Frigate itself runs in Docker.

```bash
curl -fsSL https://raw.githubusercontent.com/tammeryousef1006/matterbridge-frigate/main/docker-install.sh | sudo bash
```

or with wget:

```bash
wget -qO- https://raw.githubusercontent.com/tammeryousef1006/matterbridge-frigate/main/docker-install.sh | sudo bash
```

- **If Docker is not installed, the script installs it first** (Docker's official installer and repository, so `apt upgrade` keeps Docker up to date). If Docker is already installed (for example for Frigate), it is used as it is. Frigate's container is not touched.
- The container is called `matterbridge`, uses the host network (needed for Matter) and restarts automatically. Its data is in `/opt/matterbridge`.
- Running the Docker installer of another of my plugins adds that plugin to the same container.
- In a Proxmox LXC, enable **nesting** (and **keyctl** for unprivileged containers) under the container's *Options → Features* first.

<details>
<summary>Frigate in Docker Compose? Add Matterbridge to the same file</summary>

Add this service next to `frigate:` in your `docker-compose.yml`:

```yaml
  matterbridge:
    image: luligu/matterbridge:latest
    container_name: matterbridge
    network_mode: host
    restart: always
    environment:
      - MATTERBRIDGE_ICE_PORT_RANGE=50000-50100
    volumes:
      - /opt/matterbridge/Matterbridge:/root/Matterbridge
      - /opt/matterbridge/.matterbridge:/root/.matterbridge
      - /opt/matterbridge/.mattercert:/root/.mattercert
```

Run `docker compose up -d matterbridge`, open `http://<this-machine>:8283`, go to **Plugins**, type `matterbridge-frigate` under *Install plugins*, click **Install** and restart Matterbridge when asked. With `network_mode: host` the plugin finds Frigate on this machine by itself, as long as Frigate's port 5000 (or 8971) and 8554 are published in its `ports:`, as in Frigate's example compose file.

</details>

### Option 3: Proxmox (community helper script)

On the **Proxmox host** shell, create a Matterbridge LXC with the [Proxmox VE community script](https://community-scripts.github.io/ProxmoxVE/scripts?id=matterbridge):

```bash
bash -c "$(curl -fsSL https://raw.githubusercontent.com/community-scripts/ProxmoxVE/main/ct/matterbridge.sh)"
```

Then open the frontend at `http://<lxc-ip>:8283`, go to **Plugins**, type `matterbridge-frigate` under *Install plugins*, click **Install** and restart Matterbridge when asked.

### Option 4: Existing Matterbridge (also the Home Assistant add-on)

Requires [Matterbridge](https://github.com/Luligu/matterbridge) 3.10 or later. Install `matterbridge-frigate` from the frontend (Plugins → Install), or:

```bash
npm install -g matterbridge-frigate
matterbridge -add matterbridge-frigate
```

Frigate as a Home Assistant add-on: Matterbridge has its own Home Assistant add-on; install the plugin in its frontend. Then check in the Frigate add-on's *Network* settings that port **5000** (or 8971) and **8554** (restream) are open, and enter your Home Assistant's IP address as the Frigate address on the plugin page.

### After installing

1. Open `http://<device-ip>:8283` and pair Matterbridge with your controller using its QR code.
2. Go to **Plugins** and open the **matterbridge-frigate** page (globe icon). The Frigate card should say *connected*, and your cameras are listed. If Frigate was not found, enter its address there, press **Test**, then **Save** and restart Matterbridge.
3. For each camera: check the preview, then **pair the camera with its own QR code** (shown on the same page) in SmartThings: *Add device → Scan QR code*.
4. Restart Matterbridge once after pairing a new camera, so live view starts reliably.

The installers print the exact address at the end.

### Updating with the installers

- Run the same installer command again: it updates Matterbridge and the plugin and keeps your settings, pairing and logins.
- You can also update from the Matterbridge frontend.
- `apt upgrade` updates Node.js or Docker safely and never touches Matterbridge.

### Uninstalling

Use the uninstaller that matches how you installed:

```bash
# Standalone
curl -fsSL https://raw.githubusercontent.com/tammeryousef1006/matterbridge-frigate/main/uninstall.sh | sudo bash
# Docker
curl -fsSL https://raw.githubusercontent.com/tammeryousef1006/matterbridge-frigate/main/docker-uninstall.sh | sudo bash
```

(`wget -qO- <url> | sudo bash` works too.)

The uninstaller:

1. Removes the Frigate plugin.
2. Asks what to do with the other plugins:
   - Press **Enter** to keep them, so Matterbridge keeps running (the default).
   - Type plugin names to remove only those.
   - Type `all` to remove Matterbridge completely.
3. When Matterbridge is removed, asks whether to delete its data (pairing, settings, plugin logins). The default is to keep it, so a later reinstall picks it up.
4. For Docker, Docker itself is never removed if you had it before. If the installer installed Docker, you are asked, and the default is to keep it. Frigate is never touched.

Proxmox helper or your own Matterbridge: remove the plugin in the frontend (Plugins).

## Setup

For most setups there is nothing to fill in: the plugin finds Frigate, reads its cameras and adds them. Everything can also be changed on the plugin page (globe icon) or in the plugin settings.

- **Frigate on port 8971 (with login)?** Enter the port `8971` and a Frigate user and password (any user you created in Frigate). Port 5000 needs no login.
- **Live audio:** works when the camera's go2rtc stream has Opus or G.711 (PCMA/PCMU) audio. Many cameras send AAC instead; then add an Opus copy to the camera's go2rtc stream in the Frigate config (Frigate's own docs recommend it for live audio too):

  ```yaml
  go2rtc:
    streams:
      front_door:
        - rtsp://user:password@192.168.1.10:554/stream1
        - "ffmpeg:front_door#audio=opus"
  ```

  The plugin page tells you when a camera needs this.
- **Which detections count:** by default every object Frigate tracks for the camera. On the plugin page you can tick only some (for example *person*) and only some Frigate zones (for example *porch*). Parked cars and other stationary objects do not count.
- **MQTT (optional):** without it the plugin follows Frigate's own WebSocket, which needs nothing. If you prefer your MQTT broker, enter it in the settings (use its IP address, not a Docker name such as `mqtt`).

## Configuration

| Option | Description |
|--------|-------------|
| `frigateHost` / `frigatePort` | Frigate's address and port (`5000`, or `8971` with login). Empty address: found automatically |
| `frigateUser` / `frigatePassword` | A Frigate user, for port 8971 |
| `discovery` | Look for Frigate when no address is set (default `true`) |
| `restreamPort` / `restreamUser` / `restreamPassword` | go2rtc's RTSP restream (default port `8554`; user and password only if go2rtc has them) |
| `mqttHost` / `mqttPort` / `mqttTls` / `mqttUser` / `mqttPassword` / `mqttTopicPrefix` | Optional MQTT broker Frigate publishes to. Empty: Frigate's WebSocket |
| `addNewCameras` | Add Frigate cameras that are not in the list yet (default `true`) |
| `cameras` | Per camera: `enabled`, `title` (name in Matter), `stream` (go2rtc stream), `rtspUrl`, `rotation`, `liveAudio`, `clipAudio`, `detections`, `objects`, `zones`, `motion` (Frigate motion counts too), `recording`, `keepConnected` |
| `debug` | Enable debug logging |

## Troubleshooting

- **"Frigate was not found on the network"**: enter Frigate's IP address on the plugin page and press **Test**. With Docker, Matterbridge needs the host network.
- **"Frigate refused the login"**: check the Frigate user and password, or use port 5000.
- **A camera is "not added": H265**: SmartThings takes H.264 only. Add an H.264 stream for that camera in go2rtc (for example a camera's H.264 sub stream, or `ffmpeg:<camera>#video=h264`, which makes Frigate's machine transcode).
- **A camera is "not added": no go2rtc restream**: add the camera under `go2rtc: streams:` in the Frigate config (the [restream](https://docs.frigate.video/configuration/restream) docs), or enter an RTSP URL for it in the plugin settings.
- **No sound in live view**: see *Live audio* in [Setup](#setup).
- **Live view does not start after pairing**: restart Matterbridge once.
- **Live view stays black with a firewall**: run the installer again (it opens the ports and sets the live view port range), or open UDP 50000–50100 and 5541–5560 yourself and set `MATTERBRIDGE_ICE_PORT_RANGE=50000-50100` for Matterbridge.
- **No motion**: on the plugin page, press **Watch** and walk past the camera. If nothing shows, check that Frigate detects objects on that camera and that the objects and zones you ticked match.

## How it works

| | From Frigate | Notes |
|---|---|---|
| Live video | go2rtc restream (RTSP, port 8554) | H.264 passed through as is; starts with the frames since the last keyframe |
| Live audio | go2rtc's Opus as is, or G.711 → Opus | built-in Opus codec (WebAssembly) |
| Motion | `events` (WebSocket `/ws` or MQTT) | moving, real objects of the chosen labels and zones; ends with the event |
| Clips | restream + a few seconds before | CMAF over mutual TLS to the controller's cloud; AAC audio (built-in encoder) |
| Snapshots | `/api/<camera>/latest.jpg` | fitted to the 64 KB Matter limit; built-in H.264 decoder as backup |

## Development

```bash
npm install
npm install --no-save matterbridge@3.10.13   # provided by Matterbridge at runtime
npm run build
npm pack
```

### Releasing

Change `version` in `package.json`, add the version to `CHANGELOG.md` and push to `main`. The *Publish to npm* workflow publishes it (with the `NPM_TOKEN` repository secret) and creates the tag and the GitHub release. Versions already on npm are skipped.

## Support

### Need help?

Join the **[Matterbridge Discord](https://discord.gg/F2GupTjQdu)** to get help with setting up Matterbridge and this plugin, and to talk with other Matterbridge users. If you think you found a bug, please open an [issue](https://github.com/tammeryousef1006/matterbridge-frigate/issues) with the Matterbridge log.

### Support the development

If this plugin is useful to you, you can support its development:

<a href="https://buymeacoffee.com/6sjde6vkzl"><img src="https://img.shields.io/badge/Buy%20me%20a%20coffee-FFDD00?style=for-the-badge&logo=buy-me-a-coffee&logoColor=black" alt="Buy me a coffee"></a>

## License

ISC. The built-in codecs keep their own licenses: see [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).
