OBSIDIAR — SUBMISSION & LAUNCH KIT

Everything needed to ship Obsidiar v1: the Lens Store description, social posts, and an asset checklist. The companion open-source README lives in README.md.

Obsidiar turns your Obsidian vault (obsidian.md) into a 3D knowledge graph you can walk around, grab, and explore on Snap Spectacles — end-to-end encrypted, paired with nothing but a password.


====================================================================
1. LENS STORE DESCRIPTION
====================================================================

Tagline (one-liner)

Step inside your notes. Your Obsidian vault as a 3D knowledge graph in AR.


Short description (store summary)

Obsidiar renders your Obsidian vault as a living 3D constellation of notes floating in front of you. Every note is a sphere — sized by length, colored by folder — connected to the notes it links to. Reach out and grab the cloud to spin it, pull it apart with two hands to zoom, and tap any note to read it. Your vault is end-to-end encrypted: you pair the Lens to your vault with a password you choose, and the server never sees your notes.


Full description

Your Obsidian vault is a graph — but on a flat screen you only ever see a slice of it. Obsidiar puts the whole thing in the space around you.

Install the free Spectacles Sync plugin in Obsidian, pick a password, and sync. Put on your Spectacles, type the same password, and your notes bloom into a 3D graph:

- Notes are spheres — bigger = longer, colored by their top-level folder (or first tag).
- Links are connections — the force-directed layout pulls related notes into clusters, so structure you didn't know was there becomes visible.
- Tap a note to open a card with its title, excerpt, tags, and link count. Tapping dims everything else so you can focus.
- Grab any sphere and drag to move the whole graph. Use two hands on two notes to rotate and scale it around you.

Nothing about your vault leaves your device unencrypted. Your password derives both the address your encrypted vault is stored at and the key that decrypts it — the backend only ever holds an unreadable blob. The password never touches the network. You can also self-host the backend.

Built entirely with a custom kinematic layout and the Spectacles Interaction Kit — no flat menus, no controllers, just your notes and your hands.


Technical details

- Platform: Snap Spectacles, built in Lens Studio 5.15, TypeScript.
- Pairing and crypto: password-derived vault locator + decryption key (domain-separated, iterated SHA-512); payload sealed with TweetNaCl secretbox (XSalsa20-Poly1305). True end-to-end — the password is never sent; the server stores only ciphertext and a derived id.
- Layout: notes seeded on a Fibonacci sphere, then relaxed with a one-time Fruchterman–Reingold force solver (repulsion + link attraction + center gravity, simulated-annealing cooldown). The cloud is normalized to a constant node density, so a 30-note and a 3,000-note vault both stay readable.
- Rendering: progressive spawn cascade in note-creation order; node scale proportional to word count; category colors spread by the golden angle for maximum distinctness; billboarded labels with uniform sizing and distance culling; depth-test-off render ordering so labels and cards never get occluded.
- Interaction: tap-vs-drag disambiguated by hold-time and travel distance; single-hand grab-anywhere to move the graph (SIK InteractableManipulation retargeted to the graph root); a custom two-hand rotate/scale gesture that works across two different notes — something SIK's per-object manipulation can't do alone — with pinch-release detected via interactor trigger state, not just hand tracking.


How to use

1. Install the Spectacles Sync plugin in Obsidian (Community Plugins) and set a password.
2. Run "Sync vault to Spectacles".
3. Launch Obsidiar on your Spectacles and type the same password.


Permissions used

- Internet access — to fetch your encrypted vault from the sync backend.
- Text input — the on-device / phone keyboard for your password.


====================================================================
2. REDDIT
====================================================================

Best subreddits: r/ObsidianMD (primary), r/Spectacles, r/augmentedreality, r/PKMS. Post natively to each; don't cross-post the same link. Lead with the demo video.


Title options

- I turned my Obsidian vault into a 3D knowledge graph I can walk around in AR (open source, end-to-end encrypted)
- Built an Obsidian to Snap Spectacles sync: explore your notes as a 3D graph you grab with your hands


Body

I've been bothered for a while that Obsidian's graph view is this beautiful 3D-feeling thing crammed onto a flat screen. So I built Obsidiar — it syncs your vault to Snap Spectacles and renders it as an actual 3D knowledge graph floating in the room.

Each note is a sphere (sized by length, colored by folder), links are connections, and a force-directed layout pulls related notes into clusters. You grab the whole cloud to spin it, pull it apart with two hands to zoom, and tap any note to read its excerpt/tags/links.

The part I care about most: it's end-to-end encrypted. You pair the Lens to your vault with a password you pick. That password derives both the storage address and the decryption key, so the backend only ever stores an unreadable blob — and the password itself never leaves your device. You can self-host the backend too.

It's three open-source pieces (all MIT):
- an Obsidian community plugin that serializes + encrypts your vault,
- a roughly 130-line backend that just stores ciphertext,
- the Lens itself (a single TypeScript component).

Some things I had to solve that were more fun than expected:
- keeping the graph readable from 30 notes to thousands (constant-density normalization after the force solve, instead of fitting to a fixed sphere),
- a two-hand rotate/scale gesture that works when each hand grabs a different note — the Spectacles Interaction Kit only does two-hand when both hands grab the same object, so I wrote a custom one,
- tap-vs-drag that feels right (decided on release from hold time + how far the graph actually moved).

Repos + setup in the comments. Happy to answer anything about the crypto, the layout math, or building for Spectacles.

(First comment: links to the lens repo, the plugin repo, and the Lens Store page.)


====================================================================
3. LINKEDIN
====================================================================

Obsidian's graph view is gorgeous — and trapped behind glass. So I rebuilt it in augmented reality.

Obsidiar syncs your Obsidian vault to Snap Spectacles and renders your notes as a 3D knowledge graph you can stand inside. Notes are spheres — sized by length, colored by folder. Links pull related notes into clusters via a force-directed layout. You grab the cloud to rotate it, pull it apart with two hands to zoom, and tap any note to read it.

What I'm proud of under the hood:

End-to-end encryption by design. You pair the Lens with a password you choose. That single password derives both the storage locator and the decryption key, so the backend only ever holds ciphertext — and the password never leaves your device. Self-hostable.

Readable at any scale. A one-time Fruchterman–Reingold force solve clusters linked notes, then the cloud is normalized to a constant density — so 30 notes and 3,000 notes are equally legible.

Hands, not menus. Grab-anywhere movement, a custom two-hand rotate/scale gesture across two different notes, and tap-to-focus — all built on the Spectacles Interaction Kit.

The whole thing is open source (MIT): an Obsidian community plugin, a tiny backend, and the Lens. Links in the comments.

If you work in spatial computing, PKM, or you just love a good knowledge graph — I'd love your thoughts.

#SnapSpectacles #AugmentedReality #SpatialComputing #Obsidian #KnowledgeGraph #PKM #LensStudio #OpenSource


====================================================================
4. THREADS / X
====================================================================

Option A (story):

Obsidian's graph view but you can walk around inside it.

Obsidiar syncs your vault to Snap Spectacles as a 3D knowledge graph. Notes are spheres, links pull them into clusters. Grab it, spin it, pull it apart with two hands, tap to read.

End-to-end encrypted. Open source.


Option B (build-in-public):

shipped v1. your Obsidian vault as a 3D graph you grab with your hands, in AR on Snap Spectacles.

- notes = spheres (size = length, color = folder)
- force-directed clustering
- two-hand rotate/scale
- end-to-end encrypted, paired with just a password

all open source. links below.


Reply / second post (both options):

Three MIT repos: the Obsidian plugin, a roughly 130-line backend that only ever sees ciphertext, and the Lens. Your password derives both the storage address and the key — it never leaves your device.


====================================================================
5. HASHTAGS & HANDLES
====================================================================

#Obsidian #ObsidianMD #SnapSpectacles #Spectacles #AugmentedReality #AR #SpatialComputing #LensStudio #KnowledgeGraph #PKM #SecondBrain #OpenSource #E2EE

Tag where relevant: @obsdmd, @Snap / Snap AR, #MadeWithLensStudio.


====================================================================
6. PRE-SUBMISSION ASSET CHECKLIST
====================================================================

- Rename the Lens — Obsidiar_Lens.esproj still shows the template lensName "AIPlayground". Set it to Obsidiar in Project Settings before submitting.
- Lens icon — clean mark (a node-cluster / linked-spheres glyph reads well at small sizes).
- Preview video — record the real flow: sync in Obsidian, type password, graph blooms, grab/rotate, two-hand zoom, tap a note, card opens. 15–30s, no dead air.
- Screenshots — (1) full graph, (2) a card open with neighbors highlighted, (3) two-hand zoom mid-gesture.
- Trim the template — the project still carries Spectacles AI-sample scripts (OpenAIAssistant, GeminiAssistant, etc.). Remove unused ones so the published Lens is lean.
- Permissions — confirm Internet Access whitelists the backend host and Text Input is declared.
- Backend — confirm the Railway deployment is up (GET /health) and within any free-tier limits for launch traffic.
- Repo links — publish the lens repo, confirm the plugin repo is public, and put all three links in the Reddit first comment + LinkedIn/Threads replies.
- Plugin submission (optional) — if not already, submit Spectacles Sync to the Obsidian community plugin directory so users can install it without sideloading.
