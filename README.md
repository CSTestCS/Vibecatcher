# Vibecatcher

A transparent, always-on-top desktop overlay for Windows. It watches your screen, finds humanoid characters, and draws a VRoid / VRM model over each one. The model is posed to match the character from the same camera angle and lit to match the scene. You keep using your PC normally: the overlay is click-through everywhere except its own gear button and menu.

- **30 fps** loop: screen capture → pose detection → tracking → retargeting → rendering.
- **Multiple characters**: up to the number you choose ("Max characters at once", 1–8).
- **Lighting match**: each model gets its own key light (colour, direction, strength) and ambient light, estimated from the pixels of the character it covers.
- **Invisible 3D environment**: the canvas is fully transparent, so only the models are drawn.
- **Back-face culling toggle** for the models.
- **Fully offline**: the pose models and the WASM runtime ship inside the app. Every network request is blocked at the session level and DNS resolution is disabled.
- **Settings menu** collapses into a small gear. Click the gear to open or close the menu, or drag it to move it anywhere on screen.

## Modes

### 1 · Legs (waist-down)

Pick a **base VRoid model** (`.vrm` exported from VRoid Studio). For every detected character, Vibecatcher:

1. Loads the full VRoid skeleton but **shows only the waist-down** part of the mesh. The face, hair, upper body and (optionally) the base model's own clothing are removed.
2. **Matches skin colour** by sampling the character's face and tinting the body texture.
3. **Matches leg proportions**: thigh and shin length relative to the torso, and thigh thickness when a segmentation mask is available. The legs are reshaped in the rest pose and re-bound, so they still bend cleanly.
4. **Classifies the leg wear** (pants, capris, shorts, short shorts, skirt, mini, midi, long skirt, socks, knee socks or thigh-highs). It picks a matching item from the **bottoms library**, tinted with the average colour the character is wearing, and bakes it onto the body texture.
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
- Use **Lite** detection for speed and **Heavy** for accuracy.

## Bottoms library

The built-in library covers jeans, slacks, leggings, plaid pants, sheer tights, capris, shorts, denim shorts, bike shorts, short shorts, pleated and plaid skirts, mini, midi and long skirts, briefs, socks, knee socks and thigh-highs. Patterns are procedural (denim, knit, ribbed, pleats, plaid, sheer).

You can add your own items. **Open folder** in the menu opens `%APPDATA%\Vibecatcher\bottoms`. Put one JSON file per item there, plus an optional tileable greyscale PNG:

```json
{
  "id": "cargo-shorts",
  "name": "Cargo shorts",
  "category": "shorts",
  "layer": "bottom",
  "top": -0.3,
  "hem": "auto",
  "pattern": "image",
  "image": "cargo.png",
  "scale": 1,
  "opacity": 1,
  "waistband": true,
  "cuff": true
}
```

- `category`: `pants`, `capris`, `shorts`, `short-shorts`, `skirt`, `mini-skirt`, `midi-skirt`, `long-skirt`, `none`; or, for `"layer": "legwear"`, `socks`, `knee-socks`, `thigh-highs`.
- `top` and `hem` are positions along the leg: `-0.35` = waist, `0` = hip joint, `0.5` = knee, `1` = ankle, `1.15` = sole. `"auto"` uses the length measured on the character.
- `pattern`: `plain`, `denim`, `knit`, `ribbed`, `pleats`, `plaid`, `sheer`, or `image`, which uses the PNG as a detail map. The colour always comes from the character.

An item whose `id` matches a built-in item replaces it.

## Where data is stored

`%APPDATA%\Vibecatcher\` holds `settings.json`, `characters.json` (the leg saves and load counts) and `bottoms\`.

## Building locally (optional)

```bash
npm ci
npm start          # downloads models (build-time only), bundles, runs the overlay
npm test           # unit tests (FBX writer, leg-wear classifier, bottoms picker, keys)
npm run dist       # Windows .exe (run on Windows, or let CI do it)
```

For development, `VIBE_TEST_SOURCE=path/to/image.jpg npm start` feeds a still image instead of the screen. `test/harness/` is a browser harness that exercises model loading, the legs pipeline, retargeting and FBX export against a sample VRM.

## Notes and limitations

- Pose detection uses MediaPipe Pose Landmarker, which is trained on real people. It works well on realistic and semi-realistic 3D characters. Heavily stylised or chibi characters may be detected less reliably.
- The overlay excludes itself from screen capture (Windows 10 2004+) so it never detects its own models. A side effect is that it also won't show up in your own screenshots or recordings.
- The models are drawn over the screen. They don't know what in the game scene is in front of the character, so they are never hidden behind scene objects.
- `.vrn` files are accepted in the file picker as well as `.vrm` / `.glb`.
