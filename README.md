<div align="center">

# Obsidiar — Lens

**Explore your [Obsidian](https://obsidian.md) vault as a 3D knowledge graph on Snap Spectacles.**

End-to-end encrypted · paired with a password · open source (MIT)

</div>

---

Obsidian's graph view is a flat slice of something that wants to be spatial. **Obsidiar** renders your whole vault as a 3D constellation floating in front of you on **Snap Spectacles**: notes are spheres, links are connections, and a force-directed layout pulls related notes into clusters you can grab, spin, and walk around.

This repository is the **Lens** half of the project. It fetches your encrypted vault, decrypts it on-device, and renders + drives the graph.

https://github.com/r3d5/obsidian-spectacles-sync ← the companion Obsidian plugin

> ⚠️ Pairing is **password-based**. Type the same password on the Lens that you set in the Obsidian plugin — there's no separate code or QR step.

---

## The ecosystem

Obsidiar is three small, independent, MIT-licensed pieces:

```
┌─────────────────────┐   encrypt    ┌──────────────────┐   ciphertext   ┌────────────────────┐
│  Obsidian plugin    │  ──────────▶ │   Sync backend   │ ◀───────────── │   Obsidiar Lens    │
│  "Spectacles Sync"  │   POST /sync │  (stores blobs)  │  GET /vault/:id │   (this repo)      │
│  serialize + seal   │              │   never decrypts │   decrypt local │   render + interact │
└─────────────────────┘              └──────────────────┘                └────────────────────┘
        password ──────────────── derives id + key (never sent) ──────────────── password
```

| Component | What it does | Repo |
|---|---|---|
| **Spectacles Sync** (Obsidian plugin) | Serializes your vault to JSON, encrypts it locally, uploads the ciphertext. | [`r3d5/obsidian-spectacles-sync`](https://github.com/r3d5/obsidian-spectacles-sync) |
| **Sync backend** | ~130-line Node HTTP server. Stores and serves encrypted blobs by id. Reads nothing. | included in the plugin project / self-hostable |
| **Obsidiar Lens** | Fetches, decrypts, lays out, renders, and lets you manipulate the graph. | **this repo** |

---

## How pairing works

Your password is the only shared secret. It is run through a domain-separated, iterated SHA-512 derivation **twice**:

- `deriveVaultId(password)` → the address your encrypted vault is stored at on the backend.
- `deriveKey(password)` → the 32-byte key that decrypts it.

The plugin seals the vault JSON with **TweetNaCl `secretbox`** (XSalsa20-Poly1305) before upload. The Lens re-derives the same id + key from the password you type, `GET`s the blob, and opens it locally. The **password never travels over the network**, and the backend only ever holds ciphertext plus a derived identifier — it cannot read your notes, and neither can anyone with access to the server.

> **Honest crypto note:** the KDF is iterated SHA-512 (20k rounds for the key, 4k for the id), domain-separated with `osv-key|` / `osv-id|` prefixes. It runs once per sync/decrypt, never per frame. It is intentionally simple and interoperable across the plugin (Node) and the Lens (Lens Studio JS) — it is *not* a memory-hard KDF like scrypt/argon2. Pick a strong password. The derivation must stay byte-for-byte identical on both sides (see `deriveKey` / `deriveVaultId` in `Assets/Scripts/VaultGraphRenderer.ts` and the plugin's `src/e2e.ts`).

---

## Features

- 🪐 **3D force-directed graph** — notes cluster by their links, not by a grid.
- 🎨 **Meaningful encoding** — sphere size = word count; color = top-level folder (or first tag), hues spread by the golden angle so categories stay distinct.
- 📈 **Readable at any scale** — the cloud is normalized to a constant node density, so 30 notes and 3,000 notes are equally legible.
- 🌱 **Progressive bloom** — notes spawn in creation order with a grow-in animation; edges draw once the nodes settle.
- 👆 **Tap to focus** — tap a note to open an info card (title, excerpt, tags, links · words) and dim everything unrelated.
- ✋ **Hands-first navigation** — grab *any* note to move the whole graph; use two hands on two notes to rotate and scale it.
- 🔒 **End-to-end encrypted** — see above.

---

## Architecture

All Lens logic lives in a single component: [`Assets/Scripts/VaultGraphRenderer.ts`](Assets/Scripts/VaultGraphRenderer.ts).

### Load → decrypt → build
`onStart` opens the keyboard for the password → re-derives `vaultId` + `key` → `fetchWithRetry` the envelope → `secretbox.open` → parse vault JSON → `buildGraph`. Every failure path re-opens the keyboard with a recoverable message, so the user is never stranded.

### Layout
1. **Seed** — notes placed on a Fibonacci sphere (even, overlap-free starting point).
2. **Relax** — a one-time **Fruchterman–Reingold** solve: all-pairs repulsion (`k²/d`), link attraction (`d²/k`), gentle center gravity, clamped to a cooling "temperature" that anneals big early moves into a settled structure. Runs in flat `Float32Array`s to stay GC-free during load.
3. **Normalize density** — instead of fitting the result into a fixed radius (which crowds large vaults), the cloud is rescaled so the *median nearest-neighbor gap* equals a configurable spacing. Density, not outer size, is held constant.

### Rendering
- Node color is written via a small material-property shim (`setMatColor`) that targets whatever color uniform the material exposes — the stock node prefab uses Crafty "Modeling Clay", whose tint is `Tweak_N20`, not `baseColor`. Configurable via the **Node Color Property** input.
- Labels billboard toward the camera, are kept a uniform size regardless of node scale, and can be distance-culled.
- Labels (998), card form (999), and card text (1000) render with depth-test off so 3D spheres can never occlude them. While a card is open, floating titles hide so nothing bleeds over the panel.

### Interaction
- **Tap vs. drag** is decided on release from **both** hold time (`tapMaxSec`) and how far the graph actually moved (`dragThreshold`) — a brief, near-still pinch selects; anything longer or further is a drag.
- **Single-hand move** retargets each node's SIK `InteractableManipulation` onto the graph root, so dragging any sphere moves the whole cloud.
- **Two-hand rotate/scale** is custom. SIK only goes two-handed when both hands grab the *same* object; Obsidiar tracks the hand (`interactor`) behind each node grab and, when two *different* notes are held, parks the per-node manipulators and drives the graph root's rotation/scale/translation from the two hand positions. Release is detected via the interactor's **trigger state** (`currentTrigger`), not just hand tracking — so letting go actually stops the gesture.

---

## Lens Studio setup

Built with **Lens Studio 5.15** for **Spectacles**. Requires the **Spectacles Interaction Kit** and **LSTween** packages (already referenced in the project).

1. **Permissions** — Project Settings → enable **Internet Access** and whitelist your backend host (default `spectacles-sync-backend-production.up.railway.app`). Enable **Text Input** (the password keyboard).
2. **Internet Module** — add one in the Asset Browser if absent.
3. **Scene objects**
   - **GraphRoot** — an empty SceneObject ~100 cm in front of the camera; nodes spawn under it. Add a SIK `InteractableManipulation` (center grab) to it.
   - **Node prefab** — a small sphere with a child **Text** label and a child **TextPanel** (info card: an Image/mesh background + a Text child). Give it a **Collider**, an **Interactable**, and an **InteractableManipulation** (the script retargets it to GraphRoot).
   - *(optional)* **Edge prefab** — a thin cylinder (height 1 along +Y, centered).
4. **Attach** `VaultGraphRenderer` to a SceneObject and wire the inputs (Internet Module, Node Prefab, Graph Root, Backend URL, etc.). Every input has an inline `@hint` describing it.

### Key tuning inputs
| Input | Effect |
|---|---|
| `nodeSpacing` | Center-to-center gap held constant across vault sizes. Raise if nodes/labels overlap. |
| `nodeColorProperty` | Material uniform the node color is written to (`Tweak_N20` for the stock material, `baseColor` for PBR). |
| `labelScale` / `labelMaxDistance` | Uniform label size; optional distance-culling (0 = always show). |
| `tapMaxSec` / `dragThreshold` | Tap-vs-drag thresholds (time + travel). |
| `clusterLayout` + `repulsion` / `linkAttraction` / `linkLength` / `centerGravity` | Force-solver behavior. |
| `colorByFolder` | Color by top-level folder (default) or by first tag; auto-falls back to whichever has variety. |

---

## What's in this repo

- `Assets/Scripts/VaultGraphRenderer.ts` — the entire Lens component (load, decrypt, layout, render, interaction, KDF).
- `Assets/Scripts/nacl.js` — TweetNaCl v1.0.3, patched for the Lens Studio JS engine.
- `Assets/NodePrefab.prefab`, `Assets/LinePrefab.prefab` — node and edge prefabs.
- `SUBMISSION.md` — Lens Store description + launch posts.

> The project began from a Spectacles template and may still carry unused sample scripts (`OpenAIAssistant`, `GeminiAssistant`, …). They aren't part of Obsidiar and can be removed.

---

## Self-hosting the backend

The backend is deliberately tiny (`POST /sync`, `GET /vault/:id`, `DELETE /vault/:id`, `GET /health`) and stores only encrypted blobs. Deploy it anywhere Node ≥18 runs (Railway, Fly, a VPS), then point both the plugin's **Backend URL** setting and the Lens's `backendUrl` input at your instance. Because everything is end-to-end encrypted, the host never sees your notes.

---

## Privacy

- The **password never leaves your device** — only a derived id and ciphertext are uploaded.
- Inside the encrypted blob: note titles, paths, a 280-char excerpt per note, tags, links, frontmatter, headings, word counts, timestamps (full bodies only if you opt in, in the plugin).
- Exclude notes via the plugin's **Excluded folders / tags**. Delete your uploaded blob any time with the plugin's **Delete remote data**.

---

## Credits

- [Spectacles Interaction Kit](https://developers.snap.com/spectacles) & LSTween — Snap.
- [TweetNaCl.js](https://tweetnacl.js.org/) — crypto.
- [Obsidian](https://obsidian.md) — the vault this all orbits.

## License

[MIT](LICENSE) © 2026 Maksym Tsymbal
