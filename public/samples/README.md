# palm-moving.webm

6 s, 1280×720, 30 fps, VP9. An open right palm facing the camera, drifting,
turning (up to ~40°), tilting and doing one fast sweep — used by the
`?video=samples/palm-moving.webm` test mode.

**Source:** generated for this project by rendering the WebXR Input
Profiles "generic-hand" model with three.js, then adding a slight blur and
sensor-like noise. How to regenerate it: `scripts/sample-clip/README.md`.

**Licence:** the hand model is MIT-licensed (© 2019 Amazon, see
`scripts/sample-clip/LICENSE-generic-hand.md`); three.js is MIT. The clip
contains no third-party footage.

# palm-still.webm

5 s, 1280×720, 30 fps, VP9. The same hand held perfectly still (the frame at
t = 1 s of the moving clip) with fresh sensor-like noise in every frame: any
movement of the wound on it is tracking jitter. Open
`?video=samples/palm-still.webm` and turn on **Debug → Jitter**.

Same source and licence as above.
