# Vibecatcher

A transparent, always-on-top desktop overlay for Windows. It watches your screen, finds humanoid characters, and draws a VRoid / VRM model over each one. The model is posed to match the character from the same camera angle and lit to match the scene. You keep using your PC normally: the overlay is click-through everywhere except its own gear button and menu.

- **30 fps** loop: screen capture → person detection → per-character pose tracking → retargeting → screen alignment → rendering.
- **Multiple characters**: up to the number you choose ("Max characters at once", 1–8).
- **Lighting match**: each model gets its own key light (colour, direction, strength) and ambient light, estimated from the pixels of the character it covers.
- **Invisible 3D environment**: the canvas is fully transparent, so only the models are drawn.
- **Back-face culling toggle** for the models.
- **Fully offline**: the pose models and the WASM runtime ship inside the app. Every network request is blocked at the session level and DNS resolution is disabled.
- **Settings menu** collapses into a small gear. Click the gear to open or close the menu, or drag it to move it anywhere on screen.

## How tracking works

1. **Person detection.** A COCO person detector (EfficientDet) finds every humanoid on screen. Unlike a face-based detector, it also finds characters seen from behind, partly off-screen, small or in front of busy backgrounds.
2. **Per-character pose tracking.** Each character gets its own pose model, fed a high-resolution crop that follows it, so distant characters get the model's full resolution.
3. **Cleaning.**
   - Sudden left/right label swaps (common when legs cross or a character turns) are undone.
   - Limbs whose length suddenly jumps are treated as unreliable.
   - Limbs that are hidden or off-screen keep their last pose instead of flailing.
4. **Smoothing.** Every landmark and the model's placement go through a One-Euro filter: strong smoothing when still (no shaking), low lag when moving.
5. **Camera cuts** are detected. Smoothing is reset so the pose snaps to the new shot instead of sliding across it, and characters are re-identified. A character whose legs were already built gets them back instantly.
6. **Pin limbs to the character** (on by default). After the 3D pose is applied, each joint (hips, knees, ankles, feet, and arms in mode 2) is re-aimed so that it lands exactly on the character's joint on screen. Depth comes from the 3D pose. This is what makes the legs sit on the character like a skin.

## Modes

### 1 · Legs (waist-down)

Pick a **base VRoid model** (`.vrm` exported from VRoid Studio). For every detected character, Vibecatcher:

1. Loads the full VRoid skeleton but **shows only the waist-down** part of the mesh. The face, hair, upper body and (optionally) the base model's own clothing are removed.
2. **Matches skin colour** by sampling the character's face (or hands, when seen from behind) and tinting the body texture.
3. **Matches leg proportions**: thigh and shin length relative to the torso, and thigh thickness when a segmentation mask is available. The legs are reshaped in the rest pose and re-bound, so they still bend cleanly.
4. **Classifies the leg wear** (pants, capris, shorts, short shorts, skirt, mini, midi, long skirt, socks, knee socks or thigh-highs). It picks the matching texture from **your bottoms folder**, recolours it with the average colour the character is wearing, and lays it over the skin texture using the model's UV layout.
5. Saves a **character key** built from skin tone, hair colour and length, top colour, bottom colour and leg-wear type, together with the bottoms that were chosen. When the same character returns (even after leaving the screen), it gets the same legs.
6. Counts **how often each character is loaded**. The menu lists every save with its load count. You can delete selected saves, or use **Clean up** to remove all saves loaded fewer than N times.

### 2 · Motion capture

**Import your own `.vrm`**. The model mimics the motion of the followed character, either the largest on screen or the n-th from the left. Press **● Record** to start capturing the skeleton at 30 fps, **■ Stop** to finish, then **Export .fbx**.

The FBX is a binary FBX 7.4 animation file. It contains your model's own bone hierarchy and keyframes at 30 fps, in centimetres, Y-up. It imports into Blender, Unity, Unreal and Maya. **Record root motion** optionally keeps the hips' travel.

## Getting the .exe

You don't need to build anything yourself. Each push runs the **Build Windows .exe** GitHub Actions workflow on a Windows runner:

- **Actions → Build Windows .exe → (latest run) → Artifacts → `Vibecatcher-windows`** contains:
  - `Vibecatcher-<version>-portable.exe`: a single file you can run directly, with no install.
  - `Vibecatcher-<version>-setup.exe`: an installer.
- Pushes to the default branch also update a **`latest-build`** pre-release, and pushing a tag like `v1.0.0` creates a normal GitHub Release. Both have the `.exe` files attached.

The models are downloaded only at **build time** in CI. The finished app never connects to the internet.

## Using it

1. Start `Vibecatcher.exe`. A gear appears in the top-left corner, and the app also has a tray icon.
2. Open the menu (click the gear, or press **Ctrl+Alt+V**) and choose the mode, the display to watch and the other options.
3. Mode 1: **Choose .vrm…** to pick your base VRoid model. Mode 2: **Import .vrm…** to pick the model you want to animate.
4. **Ctrl+Alt+H** hides or shows the whole overlay. Quit from the menu or the tray.

Tips:

- **Camera FOV** should roughly match the game's field of view. It controls how depth and perspective are solved.
- **Show detected skeleton** draws the detected landmarks, which helps when tuning.
- **Motion smoothing**: higher = steadier but slightly more lag.
- **Detection model** (pose): **Lite** for speed, **Full** (default) or **Heavy** for accuracy. **Person detector**: **Fast** (default) or **Accurate**.
- **Person confidence / Pose confidence**: lower them if characters are missed, raise them if things that aren't characters get picked up.
- **Camera-cut sensitivity**: raise it if cuts are missed (poses slide between shots), lower it if fast camera pans are treated as cuts.
- **Pose processing**: GPU (default) or CPU, for PCs where GPU acceleration misbehaves.

## Bottoms textures

There are no built-in bottoms; you supply them. Click **Open folder** in the menu to open `%APPDATA%\Vibecatcher\bottoms`, drop your PNG textures in, then click **Reload**.

Each texture must be **UV-mapped to the VRoid body texture** (the same layout as the base model's `Body_00_SKIN` texture). Transparent pixels show the skin; opaque pixels cover it. The texture is laid over the skin texture pixel for pixel, scaled to the skin texture's size if the resolution differs.

The **file name** says what kind of leg wear it is:

```
<category>.png        or        <category>_<anything>.png
```

| Category | Used when the character wears |
|---|---|
| `pants` | full-length trousers, jeans, leggings |
| `capris` | trousers ending between knee and ankle |
| `shorts` | shorts ending around mid-thigh to knee |
| `short-shorts` | very short shorts |
| `skirt`, `mini-skirt`, `midi-skirt`, `long-skirt` | skirts of each length |
| `none` | bare legs (e.g. underwear / briefs) |
| `socks`, `knee-socks`, `thigh-highs` | socks; layered on top of the bottom |

Examples: `pants_jeans.png`, `pants_denim.png`, `shorts.png`, `skirt_pleated.png`, `mini-skirt_plaid.png`, `thigh-highs_white.png`.

- If you have several textures in a category, words in the `<anything>` part help pick one. Use `denim` / `jean` for denim-looking clothes, `plaid` / `check` / `print` / `pleat` for patterned ones, and `plain` / `solid` for flat colours. Otherwise the first file alphabetically is used.
- If a category has no texture, the closest one is used (for example `skirt` for a mini skirt). If the folder is empty, only the skin is shown.
- Textures are **recoloured** with the character's clothing colour, keeping the texture's own shading. Put `notint` in the name (e.g. `shorts_camo_notint.png`) to keep its original colours.
- Files whose names don't start with a category are ignored, and the menu lists them.
- Each saved character remembers the texture file it was given. If you delete or rename that file, the character is re-assigned the closest texture you have.

## Where data is stored

`%APPDATA%\Vibecatcher\` holds `settings.json`, `characters.json` (the leg saves and load counts) and `bottoms\`.

## Building locally (optional)

```bash
npm ci
npm start          # downloads models (build-time only), bundles, runs the overlay
npm test           # unit tests (FBX writer, leg-wear classifier, bottoms picker, keys)
npm run dist       # Windows .exe (run on Windows, or let CI do it)
```

For development, `VIBE_TEST_SOURCE=path/to/image.jpg` (or a `.mp4` video, stepped exactly one frame per processed frame) feeds that instead of the screen. `VIBE_DEBUG=1` logs tracking metrics (joint alignment error and jitter in pixels, cuts, timings) to the console. `test/harness/` is a browser harness that exercises model loading, the legs pipeline, retargeting and FBX export against a sample VRM.

## Notes and limitations

- The detectors (MediaPipe Pose Landmarker and EfficientDet) are trained on real people. They work well on realistic and semi-realistic 3D characters. Heavily stylised or chibi characters may be detected less reliably.
- The pose model needs to see enough of the body to place the joints. When only part of a character is visible, the visible limbs are tracked, and hidden ones keep their last pose.
- The overlay excludes itself from screen capture (Windows 10 2004+) so it never detects its own models. A side effect is that it also won't show up in your own screenshots or recordings.
- The models are drawn over the screen. They don't know what in the game scene is in front of the character, so they are never hidden behind scene objects.
- `.vrn` files are accepted in the file picker as well as `.vrm` / `.glb`.
