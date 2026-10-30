# Sample clip generator

Renders `public/samples/palm-moving.webm`: an open right palm facing the
camera, moving, turning and tilting, with one fast sweep. It's used by the
app's `?video=` test mode.

```bash
npx vite                                   # serves the repo, incl. node_modules/three
node scripts/sample-clip/record.mjs        # needs Playwright; writes sample-clip-frames/
ffmpeg -framerate 30 -i sample-clip-frames/f%04d.png \
  -vf "gblur=sigma=0.6,noise=alls=6:allf=t+u,format=yuv420p" \
  -c:v libvpx-vp9 -b:v 800k -maxrate 1100k -row-mt 1 -an public/samples/palm-moving.webm
```

`palm-still.webm` (for measuring jitter: the same hand held still at
t = 1 s, so only sensor noise changes between frames) is made the same way
from a still render, 5 s long:

```bash
node scripts/sample-clip/record.mjs http://localhost:5173/scripts/sample-clip/render.html sample-clip-still 1.0
ffmpeg -framerate 30 -i sample-clip-still/f%04d.png -t 5 \
  -vf "gblur=sigma=0.6,noise=alls=6:allf=t+u,format=yuv420p" \
  -c:v libvpx-vp9 -b:v 700k -row-mt 1 -an public/samples/palm-still.webm
```

`render.html` also exposes `handPointAt(t, x, y)` (the point on the hand
under a pixel at time t, in the hand's own frame) and
`projectHandPoint(t, point)` (where that point is in the image at time t):
ground truth for measuring how far the wound slides over the hand.

The blur and noise imitate a webcam (soft image, sensor noise) so the
app's camera matching has something real to measure.

**Licences.** The hand is the WebXR Input Profiles "generic-hand" model
(`generic-hand-right.glb`), MIT licence, © 2019 Amazon — see
`LICENSE-generic-hand.md`. It's rendered with three.js (MIT). The clip itself
was generated for this project.
