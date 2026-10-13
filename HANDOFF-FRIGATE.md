# Handoff: matterbridge-frigate (memory of the build chat, 2026-10-13)

Read with HANDOFF.md of the Camera Lab artifact (https://claude.ai/artifact/UtHQzpHXZp3jXj1T2ir3nf): the standing
rules there still apply (no npm publish without an explicit go, .tgz builds, no PRs unless asked, no secrets in chat,
ignore fabric-not-found, no ffmpeg, stream stability first, explain simply).

## Where things are
- Artifact "Matterbridge Frigate" (this one): page with test results, `source/` (src, schema, page, docs),
  `tests/` (fake Frigate + test scripts), `builds/matterbridge-frigate-0.1.0.tgz`.
- Vendor WASM codecs are unchanged from matterbridge-claude 0.9.8; they are copied under `source/vendor/`
  (`fdk.wasm.js` stored as `fdk.wasm.js.b64`, sha256 of the decoded file 9fc5bad87a6648fa085040ece6b201c82124f479788d02ccfe5913f870fa0682).
- Build: `npm install`, `npm install --no-save matterbridge@3.10.13`, `npm run build`, `npm pack`.

## What 0.1.0 does (tested locally against a fake Frigate, not yet on the user's network)
- Frigate: address in settings, else discovery (127.0.0.1, `frigate`, `frigate.local`, then local /24 on 5000/8971,
  confirmed by /api/version; 8971 = HTTPS self-signed, POST /api/login -> `frigate_token` cookie, renewed on 401).
  Any Frigate user works (tested admin and a viewer user).
- Cameras from /api/config (ui.order, friendly_name, else "front_door" -> "Front Door"); new ones added switched on
  (Frigate-disabled ones switched off); setting addNewCameras.
- Streams: candidates = live.streams values (0.15+), live.stream_name (0.14), camera name, name_sub etc., only if in
  go2rtc.streams. Each checked by RTSP DESCRIBE of `rtsp://host:8554/<stream>?video=all&audio=all` (codec, SPS size,
  audio). Default best H.264 <= 1080p. H.265 reported and skipped. Per-camera stream choice added to the form (setSchema).
- IMPORTANT bug found and fixed: go2rtc ignores the interleaved channel the client asks for in SETUP and numbers by
  its own (changing) track order; rtsp.ts now uses the channel from the SETUP answer (before: ~1 in 6 connects had
  no video).
- Live audio: go2rtc Opus track passed as is (packet duration from TOC), else G.711 -> Opus; AAC-only = no live audio
  + hint `ffmpeg:<camera>#audio=opus`. The mic slider gain does not apply to passed-through Opus.
- Clip audio: camera AAC as is, else AAC from G.711, else AAC from Opus (decoded to 8 kHz).
- Detections: MQTT (own 3.1.1 client, `<prefix>/events`, `<prefix>/+/motion`, `<prefix>/available`) when mqttHost is
  set, else Frigate /ws (own WebSocket client, cookie on 8971). Active = not end, not stationary, not false
  positive, label/zone filters; 3 min stale timeout; optional Frigate motion. -> occupancy + Zone events + Push AV trigger.
- Snapshots: /api/<cam>/latest.jpg?height&quality fitted to 64000 B; stream keyframe decoder if Frigate fails or
  rotation is set; last snapshot as final fallback.
- Plugin page: Frigate card (search, test incl. restream + MQTT, save), camera list, streams, preview, Frigate snapshot,
  listen, detections watch, settings, QR / "Paired with". Removed from 0.9.8: ONVIF, Tapo, two-way talk.

## Local test results (fake Frigate = real go2rtc 1.9.9 + fake API/WS/MQTT)
- Live view (werift hub offering like SmartThings): first keyframe ~0.3 s, Opus 440 Hz tone 99.8%, CVO rotation ok.
- Clips over mutual TLS: AAC as is / PCMA->AAC / Opus->AAC all correct tone, video decodes clean.
- Matterbridge 3.10.13 (Node): discovery, cameras added (own server nodes, QR), detections -> motion, go2rtc and
  Frigate restarts recovered, page in Chromium (desktop light, phone dark) no errors, save writes one camera only.
- NOT tested: real SmartThings pairing / live view / clip upload (needs the user's network), Bun runtime.

## 0.2.0 (published from GitHub, 2026-10-13)
- Repo https://github.com/tammeryousef1006/matterbridge-frigate; npm publish runs when package.json version changes on
  main (workflow skips versions already on npm, then tags + GitHub release). This cloud session cannot push tags or
  create releases. npm staged publishing: first upload showed 0.0.0-stage, released by npm a minute later.
- License ISC (same as tapo/ewelink/ttlock); sponsor link in package.json funding, README, page, FUNDING.yml.
- README like the other plugins + install.sh/docker-install.sh/uninstall.sh/docker-uninstall.sh (copied from the Tapo
  installers; Frigate extras: firewall 5541-5560 and UDP 50000-50100, MATTERBRIDGE_ICE_PORT_RANGE via systemd drop-in
  frigate-webrtc.conf or docker -e).
- PTZ (experimental, src/ptz.ts): only when Frigate camera has onvif: and /api/<cam>/ptz/info reports pt or zoom.
  matter.js CameraAvSettingsUserLevelManagementServer.with(features) subclass; relative/absolute -> MOVE_* then STOP
  (25 ms/degree, 400 ms/zoom step), presets -> PRESET_<name> (Frigate lowercases names), save/remove refused.
  Sent via DetectionFeed.send (WS {"topic":"<cam>/ptz","payload":...} or MQTT <prefix>/<cam>/ptz). Per-camera ptz switch.
  Tested: real matter.js controller paired with the camera and sent all PTZ commands (Node); fixed camera with ONVIF
  gets no PTZ cluster. No real PTZ camera tested.
- Test env notes: container has no IPv6 -> tests/noipv6.cjs preload (UDP sockets reuseAddr + loopback); Bun cannot
  start Matter nodes here, but plugin-level tests pass on Bun 1.4.2.

## Open items / ideas
- User test of 0.1.0 (TESTING.md in the package).
- Two-way talk via go2rtc backchannel; Frigate review items (alerts) as an alternative trigger; PTZ.
- Before publishing: decide the license (ISC kept from the test plugin), repo/homepage URL, own WebRTC handling
  (as planned for matterbridge-camera-server).
