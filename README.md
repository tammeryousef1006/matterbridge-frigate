# matterbridge-frigate

Your [Frigate](https://frigate.video) NVR cameras in Matter, as [Matterbridge](https://github.com/Luligu/matterbridge)
cameras: live video and audio, Frigate's detections as motion, snapshots and cloud clip recording (Matter Push AV,
tested with SmartThings). **No ffmpeg needed**: video is passed through from Frigate's go2rtc restream, and the
small audio and picture codecs are built in (WebAssembly).

Every camera is its **own Matter device** with its own QR code.

## What you need

- Frigate (0.14 or later) with its cameras in **go2rtc** (`go2rtc: streams:` in the Frigate config, the
  [restream](https://docs.frigate.video/configuration/restream) setup). H.264 streams; H.265-only cameras need
  an H.264 stream in go2rtc.
- For live audio: an Opus track in go2rtc, e.g.
  ```yaml
  go2rtc:
    streams:
      front_door:
        - rtsp://user:pass@192.168.1.10:554/stream1
        - "ffmpeg:front_door#audio=opus"
  ```
  (G.711 cameras also work without it.)
- Matterbridge 3.10 or later, a Matter controller with camera support (SmartThings today).

## Setup

1. Install the plugin in Matterbridge and restart. Without an address it looks for Frigate on this machine and
   your network (ports 5000 and 8971) and saves what it finds; your Frigate cameras are added to the settings.
2. Open the plugin page (globe icon): check the Frigate connection and each camera's streams, preview, sound and
   detections. Change what you need and **Save**, then restart Matterbridge.
3. Pair each camera with its QR code (plugin page or Matterbridge Devices) in your controller app.

### Settings

| Setting | |
|---|---|
| Frigate address / port | 5000 = no login. 8971 = HTTPS with a Frigate user and password (any user you created in Frigate) |
| go2rtc RTSP port / user / password | 8554; user and password only if go2rtc's RTSP has them |
| MQTT broker / port / user / password / prefix | Optional. Empty: detections come from Frigate's WebSocket |
| Per camera | Add to Matter, name, go2rtc stream, rotation, live audio, clip audio, detections (objects, zones, Frigate motion), recording, keep connected, RTSP URL instead of go2rtc |

## How it works

| | From | Notes |
|---|---|---|
| Live video | go2rtc restream | H.264 passed through, starts with the cached frames since the last keyframe |
| Live audio | go2rtc's Opus as is, or G.711 → Opus | AAC-only streams: add an Opus track in go2rtc |
| Motion | Frigate events (MQTT or WebSocket) | Moving, real objects of the chosen labels/zones; ends with the event |
| Clips | restream + pre-roll | CMAF over mutual TLS to the controller's cloud; AAC audio |
| Snapshots | Frigate `latest.jpg` | fitted to 64000 B; built-in decoder as backup |

## Not yet

Two-way talk (planned where go2rtc supports the camera's backchannel), PTZ.

## Support

If the plugin is useful to you, you can support its development: [Buy me a coffee](https://buymeacoffee.com/6sjde6vkzl).

## Licenses

ISC for this plugin. The bundled codecs keep their licenses: see [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).
