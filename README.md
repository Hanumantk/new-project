# Palm injury — AR hand-tracking prototype

A single-page React + TypeScript app that uses your webcam, tracks your hand in
real time with MediaPipe's **HandLandmarker**, and renders a realistic wound
on your palm (three.js via **@react-three/fiber**) that follows, tilts and
scales with your hand: a deep laceration with raw flesh walls, blood pooled
in it, swollen torn edges, wet blood oozing out with drips, a scrape, and
bruising around it.

## Run it

```bash
npm install
npm run dev
```

Open the printed `http://localhost:5173` URL in Chrome, Edge, Firefox or
Safari and click **Start camera**. Camera access needs a secure context
(HTTPS or `localhost`). The hand model (~7.8 MB) and the MediaPipe WASM files
load from Google Storage and jsDelivr on first start, so you need internet
access.

Other scripts: `npm run build` (typecheck + production build into `dist/`),
`npm run preview`, `npm run typecheck`.

## Meta Quest 3 (mixed reality)

The AR experience (your real room through passthrough, with the wound on
your real palm, behaving like the webcam version) runs in the **Quest's own
browser**, using the headset's hand tracking:

1. In the headset, open **Browser** and go to
   `hanumantk.github.io/new-project`.
2. Tap **Start mixed reality**, then **Enter mixed reality**.
3. Put the controllers down and hold up your open palm.

To open it from the laptop over the USB cable instead of typing the address,
enable developer mode on the Quest and run (needs `adb`, e.g. from Meta Quest
Developer Hub):

```bash
adb shell am start -a android.intent.action.VIEW -d "https://hanumantk.github.io/new-project/" com.oculus.browser
```

**Quest Link (PC browser over the cable)** only supports VR, not
passthrough. The page says so, and offers a VR fallback with skin-toned
virtual hands in a simple room.

The wound goes on your right hand when it's tracked, otherwise the left; a
floating hint appears while no open hand is seen.

## How it works

| Piece | File |
| --- | --- |
| Start screen / error screen | `src/App.tsx` |
| Camera, detection loop, landmark debug overlay, cleanup | `src/components/ARView.tsx` |
| Transparent R3F canvas + lights | `src/components/ARScene.tsx` |
| Wound placement, rotation, scale, smoothing, fade, materials | `src/components/PalmInjury.tsx` |
| Procedural wound maps (colour, normals, height, roughness), built in a Web Worker | `src/lib/injury/` |
| Invisible hand that hides the wound behind it | `src/lib/handOccluder.ts` |
| Webcam landmarks → 3D hand pose, camera optics | `src/components/WebcamPoseSource.tsx` |
| Headset mode: session, VR room, hint panel | `src/components/XRView.tsx`, `src/components/XRScene.tsx` |
| Headset hand joints → the same 3D hand pose | `src/components/XRPoseSource.tsx` |
| HandLandmarker setup (VIDEO mode, 1 hand, GPU → CPU fallback) | `src/lib/handLandmarker.ts` |
| `object-fit: cover` maths shared by 2D and 3D overlays | `src/lib/coverMapping.ts` |

- **Alignment.** The video, the 3D canvas and the landmark canvas sit in one
  container mirrored with `transform: scaleX(-1)`, so all three flip together.
  Landmarks are mapped through the same cover-crop rectangle the browser uses
  for the video, and the virtual camera's field of view is set to a typical
  webcam's (~41° vertical) seen through that crop, so the wound's perspective
  matches the image.
- **Position.** Each landmark is mapped through the cover crop to a view pixel
  and placed along that pixel's camera ray, around a plane 0.5 m in front of
  the camera (offset by MediaPipe's relative depth). Palm centre = mean of
  landmarks 0, 5, 9, 13, 17; the wound is laid flat on the palm plane, nudged
  from there towards the wrist into the middle of the palm.
- **Scale.** The wrist → middle-knuckle (0 → 9) length, measured on that plane
  and divided by a typical 9 cm palm, so the wound grows as your hand comes closer.
- **Rotation.** Basis from 0 → 9 (towards the fingers) and 5 → 17 (across the
  palm); their cross product is the palm normal, flipped for left hands so the
  wound is always on the palm side.
- **The wound.** Generated procedurally at start-up (in a Web Worker, so the
  page doesn't freeze) as 1024² maps covering a 7 cm patch of palm: colour,
  height, normals and roughness. It is drawn as two layers: an unlit tint for
  bruising and redness, so it reads as discoloured skin, and a lit, displaced,
  normal-mapped mesh for the gash and blood, glossy where it's wet.
- **Occlusion.** An invisible 3D stand-in for your hand (finger capsules
  plus a palm plate, built from all 21 landmarks) writes depth but no colour,
  so the real hand hides the wound whenever it's behind it: turn your palm
  away and the back of your hand covers it; curled fingers cover parts of it.
  `src/lib/handOccluder.ts`.
- **Closed hand.** A closed hand covers the palm: when the fingertips come in
  towards the wrist (openness below 1.15, back above 1.3) the wound fades out
  and the status pill says "Open your hand".
- **Smoothing / fade.** Position, rotation and scale are lerped/slerped with
  factor 0.35 each frame; the wound fades out over 200 ms when the hand is lost
  and snaps back in place before fading in when it returns.
- **Performance.** Inference only runs when the camera has delivered a new
  frame; all per-frame maths reuses preallocated vectors; per-frame data
  lives in a ref (no React renders), and the HUD updates FPS twice a second.
  Unmounting (or **Stop camera**) cancels the loop, closes the landmarker and
  stops the camera tracks.

## Tuning

Constants at the top of `src/components/PalmInjury.tsx` (`INJURY_SIZE`,
`INJURY_OFFSET_TOWARDS_WRIST`, `REAL_PALM_LENGTH`, `WEBCAM_VFOV_DEG`,
`SMOOTHING`, `FADE_SECONDS`) and the colours and shapes at the top of
`src/lib/injury/generateInjury.ts`.

## Known limits

- The hand stand-in is an approximation (capsules and a flat palm), so the
  wound's cut-off edges follow your hand only roughly, and MediaPipe's depth
  estimate is noisy, so how much peeks out from behind the hand can wobble.
- The wound is flat on an estimated palm plane; it doesn't bend with a cupped
  palm or follow palm creases.
- The WASM URL uses `@latest` as specified; if a future MediaPipe release
  breaks compatibility with the installed npm package, pin the URL to the
  version in `package.json`.
