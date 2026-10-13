# Changelog

## 0.2.0 (2026-10-13)

- **Pan, tilt and zoom (experimental)** for PTZ cameras that Frigate controls over ONVIF: Matter's camera PTZ
  (arrows, zoom, the camera's presets) is sent to Frigate as its PTZ commands, over its WebSocket or MQTT. Only for
  cameras Frigate reports as PTZ; fixed cameras are not affected. Per-camera switch `ptz`, PTZ card on the plugin page.
  Saving/removing presets from the controller is refused (Frigate cannot create presets).
- Plugin page: says when a PTZ move could not be sent because Frigate is not connected.
- README in the layout of my other plugins, with one-line installers (standalone and Docker) that install
  Matterbridge with this plugin; with an active firewall they open the camera and live view ports.

## 0.1.0 (2026-10-13)

First release, made from the matterbridge-claude 0.9.8 camera test plugin.

- Frigate: found automatically (this machine, the names `frigate` / `frigate.local`, then the local /24 network on
  ports 5000 and 8971, confirmed with `/api/version`) or entered by address. Port 5000 without login, port 8971
  over HTTPS with a Frigate user (any user created in Frigate; the login is renewed when it expires).
- Cameras from `/api/config` (UI order, friendly names), added to the settings switched on; cameras Frigate has
  switched off are added switched off.
- Video: Frigate's go2rtc restream (`rtsp://frigate:8554/<stream>`), H.264 passed through, no re-encoding. Every
  go2rtc stream of a camera is checked (codec, size, audio); default: best H.264 up to 1080p. H.265 streams are
  reported and skipped (SmartThings takes H.264 only).
- Live audio: go2rtc's Opus track passed as is (`ffmpeg:<camera>#audio=opus`), or Opus made from G.711.
  AAC-only streams: no live audio, with a hint for go2rtc.
- Clip audio (Push AV): the camera's AAC as is, or AAC made from G.711 or from go2rtc's Opus.
- Detections: MQTT (`<prefix>/events`, `<prefix>/<camera>/motion`) when a broker is set, else Frigate's WebSocket
  (`/ws`, also on 8971 with the login). Objects (filter by label and zone; stationary objects and false
  positives do not count) and optionally Frigate's motion -> Matter occupancy, Zone events and the Push AV
  recording trigger.
- Snapshots: Frigate's `latest.jpg`, fitted to the 64000 B Matter limit; the built-in decoder makes one from the
  restream when Frigate does not answer or the picture is turned; the last snapshot while both are down.
- Every camera is its own Matter device (server mode) with recording (TLS, time sync, Push AV, zones), rotation
  (clips, snapshots, live view via CVO) and the microphone volume slider, as in 0.9.8.
- Plugin page (globe icon): Frigate connection (search, test with restream and MQTT check, save), and per camera:
  streams, 15 s preview, Frigate snapshot, listen 5 s, detections, settings, pairing QR / "Paired with".
- Sponsor link (Buy me a coffee) on the plugin page, in the README and in package.json.
- Removed from 0.9.8: ONVIF, Tapo discovery, Tapo two-way talk (two-way talk comes later where go2rtc supports it).
