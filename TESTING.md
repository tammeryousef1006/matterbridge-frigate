# matterbridge-frigate 0.1.0: what to test first

Install the .tgz in Matterbridge (`npm install -g ./matterbridge-frigate-0.1.0.tgz` in the container, or the
Matterbridge frontend "Install" with the file path), add the plugin, restart.

1. **Startup**: the log should say `Frigate found at <ip>:5000` (or set the address yourself) and
   `Connected to Frigate <version> ... N camera(s)`, one line per go2rtc stream (`go2rtc stream ... · H264 · ...`),
   and `added to Matter as "<name>"` per camera. Send me those lines:
   `docker logs --since 10m matterbridgebun 2>&1 | grep -E "Frigate|go2rtc|added to Matter|not added|WebSocket|MQTT"`
2. **Plugin page** (globe icon): Frigate card shows connected + detections; for one camera press Play 15 s,
   Frigate snapshot, Listen 5 s, Watch (walk in front of it).
3. **Pair one camera** in SmartThings with its QR (plugin page). Restart Matterbridge once after pairing (known
   Matterbridge issue, as with matterbridge-claude). Then: live view (how fast, sound?), tile picture, a
   detection in the timeline, a clip (with sound).
4. Optional: fill in MQTT on the page (Test shows whether it connects), save, restart, compare.

Live audio needs Opus or G.711 in the go2rtc stream. If your streams are AAC only, add
`- "ffmpeg:<camera>#audio=opus"` to that camera's go2rtc stream in Frigate.
