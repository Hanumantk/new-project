# Buddy - character asset package

Buddy is a small floating AR companion: a coral-red round body, two stub arms, a face drawn as a swappable texture, and a sprout on its head that grows from a tiny leaf into a yellow flower.

This package is meant to be imported into a project by a developer or coding agent. `buddy_manifest.json` holds the same information as this file in machine-readable form.

## Files

| File | What it is |
|---|---|
| `buddy_character.glb` | The model to import. Mesh, rig, 7 animations, growth morph targets, materials and the face texture are all embedded. |
| `buddy_character_source.blend` | Blender 5.2 source file for edits and re-exports. |
| `textures/buddy_face_expressions_atlas_4x4.png` | The face expression atlas (also embedded in the GLB). Use it for reference or if your pipeline needs the texture separately. |
| `previews/buddy_preview_full_flower.png` | Reference render. |
| `buddy_manifest.json` | Machine-readable spec. |

## Model facts

- glTF 2.0 binary, Y-up, metres. The character faces **+Z**.
- About 24 cm wide and 22 cm tall with the full flower.
- **The pivot is at the body centre, not the feet**, because Buddy floats. Position it where its middle should be.
- Root node `Buddy` is an armature with bones `root > body > arm.L, arm.R, sprout`. Meshes are rigidly attached to bones (no vertex weights).
- Animations only move bones, so you can move and rotate the `Buddy` node freely in code (following, hovering, turning to face the user) on top of any clip.

## Animations (24 fps)

| Clip | Frames | Length | Loop | Notes |
|---|---|---|---|---|
| `Idle_Float` | 48 | 2.00 s | yes | Default state. Gentle float bob, soft side-to-side tilt, arms and sprout sway. |
| `Wave` | 48 | 2.00 s | no (one-shot) | Right arm raises and waves 3 times. Use as a greeting, then return to the loop. |
| `Happy_Bounce` | 24 | 1.00 s | yes | Hop with squash-and-stretch, arms up. Loopable; 2-3 repeats work as a celebration. |
| `Excited` | 16 | 0.67 s | yes | Fast bob, arms flapping, sprout wiggle. Loopable. |
| `Sleepy` | 72 | 3.00 s | yes | Sinks slightly, leans forward, arms down, sprout droops. Loopable. Pair with the sleepy face. |
| `Nod_Yes` | 24 | 1.00 s | no (one-shot) | Two forward nods layered on the float. One-shot. |
| `Shake_No` | 24 | 1.00 s | no (one-shot) | Two side-to-side head shakes layered on the float. One-shot. |

Suggested pattern: keep `Idle_Float` (or another loop) running as the base state. Cross-fade (about 0.3 s) into one-shots like `Wave`, `Nod_Yes` and `Shake_No`, then cross-fade back to the loop when they finish. Do travel, hovering toward the user and turning in code, not in clips.

## Growth stages (morph targets on `Buddy_Sprout`)

The three targets are **cumulative**, so set all three weights for each stage:

| Stage | Leaf_Grow | Bud | Bloom |
|---|---|---|---|
| 0 tiny leaf | 0 | 0 | 0 |
| 1 growing leaf | 1 | 0 | 0 |
| 2 bud | 1 | 1 | 0 |
| 3 opening | 1 | 1 | 0.5 |
| 4 full flower | 1 | 1 | 1 |

The file loads at stage 4 (full flower). Set the stage you want on load. Interpolating the weights over about 1 s gives a smooth grow animation.

Engine note: the sprout uses three materials, so some engines (for example three.js) split it into three child meshes under `Buddy_Sprout`. Apply the weights to every mesh that has these morph target names.

## Expressions (face atlas)

`Buddy_Face` is a thin, alpha-blended decal over the front of the body. Its UVs cover **cell 0 (happy)**. To change expression, change the UV offset of `MAT_Buddy_Face`'s base colour texture to point at another cell. Don't swap textures.

The atlas is 2048x2048 with a 4x4 grid of 512 px cells. Cells run left to right, top to bottom:

| Index | Expression | col | row |
|---|---|---|---|
| 0 | happy | 0 | 0 |
| 1 | excited | 1 | 0 |
| 2 | curious | 2 | 0 |
| 3 | thinking | 3 | 0 |
| 4 | surprised | 0 | 1 |
| 5 | sleepy | 1 | 1 |
| 6 | wink | 2 | 1 |
| 7 | sad | 3 | 1 |
| 8 | confused | 0 | 2 |
| 9 | cheerful | 1 | 2 |
| 10 | shy | 2 | 2 |
| 11 | determined | 3 | 2 |
| 12 | blink | 0 | 3 |
| 13 | talk | 1 | 3 |
| 14 | love | 2 | 3 |
| 15 | neutral | 3 | 3 |

UV offset formula (the sign of the vertical offset depends on the engine's UV convention):

- **glTF native / three.js (GLTFLoader, flipY = false) / Babylon:** `offset = (col * 0.25, row * 0.25)`
- **Unity (glTFast) / Blender:** `offset = (col * 0.25, -row * 0.25)`

In three.js, if several Buddies share one texture object, clone the texture per instance before changing the offset.

Make it feel alive:

- **Blink:** show `blink` for about 120 ms every 2.2-5.2 s at random. Skip this while `sleepy`, `cheerful`, `wink`, `blink` or `love` is showing.
- **Talk:** while speaking, alternate `talk` with the current expression every 120-160 ms.

Rendering: keep depth write off on the face material and draw it after the body (render order / queue) so it never flickers through.

## Colour variants

Recolour by changing **only** `MAT_Buddy_Body`'s base colour (baseColorFactor). The body's soft top-to-bottom shading comes from greyscale vertex colours (`COLOR_0`) that multiply with it, so keep vertex colours enabled in the shader.

The default colour is `#EC6A67` (red). Other palette values are sRGB hex; convert to linear if your engine expects linear colour:

red `#EC6A67`, pink `#F4A3C0`, blue `#86C3F2`, yellow `#F6D25E`, mint `#8EDDB5`, lavender `#B49AEE`, orange `#F4A050`, teal `#4CC4B0`, navy `#3D4778`, white `#F3EFE8`, lilac `#C8A8EE`, grey `#B7BBC5`.

The leaves, petals and flower centre have fixed colours.

## Re-exporting from Blender

Open `buddy_character_source.blend`, select everything in the `Buddy` collection, and export glTF 2.0 with these settings:

- format **GLB**
- **+Y up**
- Animation mode **Actions**
- **Shape keys** on
- **Custom properties** on
- Vertex colour **Material**

The `Preview` collection (lights, camera, ground) is for rendering only. Don't export it.
