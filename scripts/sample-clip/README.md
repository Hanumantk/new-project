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

The blur and noise imitate a webcam (soft image, sensor noise) so the
app's camera matching has something real to measure.

**Licences.** The hand is the WebXR Input Profiles "generic-hand" model
(`generic-hand-right.glb`), MIT licence, © 2019 Amazon — see
`LICENSE-generic-hand.md`. It's rendered with three.js (MIT). The clip itself
was generated for this project.
