# Third-party notices

matterbridge-frigate runs without ffmpeg. It ships these WebAssembly builds in `vendor/`; each keeps its license,
included next to it.

| Folder | What | License |
|---|---|---|
| `vendor/opusscript` | opusscript (Opus encoder/decoder bindings) with **libopus 1.4** compiled to WebAssembly: live audio (G.711 → Opus), Opus → PCM for clip audio | opusscript: MIT (`LICENSE`); libopus: BSD-3-Clause (`build/COPYING.libopus`) |
| `vendor/encode-aac` | AAC-LC encoder: the **Fraunhofer FDK AAC** library compiled to WebAssembly, with an MIT wrapper: clip audio (G.711 / Opus → AAC) | wrapper: MIT (`LICENSE`); FDK AAC: Software License for The Fraunhofer FDK AAC Codec Library for Android (`LICENSE.fdk-aac`) |
| `vendor/snapshot` | **OpenH264** decoder (Cisco) + **stb_image_write** v1.16 compiled to WebAssembly: backup snapshots from an H.264 keyframe | OpenH264: BSD-2-Clause (`LICENSE.openh264`); stb_image_write: public domain / MIT; build steps in `BUILD.txt` |

Note on FDK AAC: its license allows redistribution in source and binary form with the notice kept, and states
that it grants no patent rights; AAC patent licensing is the user's responsibility where it applies.
Clip audio can be switched off per camera ("Clip audio: Off"), which never loads the AAC encoder.

The WebRTC stack (werift) and Matter (matter.js) come with Matterbridge, not with this package.
