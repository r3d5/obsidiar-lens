// VaultGraphRenderer.ts — Obsidian Spectacles Sync, Lens side (no camera).
//
// On start it opens the on-device/phone keyboard, takes the user's password, derives
// the backend locator + decryption key from it (same KDF as the Obsidian plugin),
// fetches the encrypted vault, decrypts it (TweetNaCl secretbox), and renders a 3D
// graph: node size scales with word count, color from the first tag, labels billboard.
//
// The password never touches the backend (true E2E). Requires Assets/Scripts/nacl.js
// (patched for the Lens) and Internet access enabled + backend host whitelisted.

import WorldCameraFinderProvider from "SpectaclesInteractionKit.lspkg/Providers/CameraProvider/WorldCameraFinderProvider";
import { RectangleButton } from "SpectaclesUIKit.lspkg/Scripts/Components/Button/RectangleButton";
import { Interactable } from "SpectaclesInteractionKit.lspkg/Components/Interaction/Interactable/Interactable";
import { InteractableManipulation } from "SpectaclesInteractionKit.lspkg/Components/Interaction/InteractableManipulation/InteractableManipulation";
import { LSTween } from "LSTween.lspkg/Examples/Scripts/LSTween";

const LENS_VERSION = "0.1.0";

const nacl = require("nacl.js");
// Explicitly require the Text Input module so Lens Studio declares the "Input
// Framework (Text)" permission — otherwise SnapOS denies requestKeyboard() at
// runtime (PERMISSION_DENIED "Input text").
require("LensStudio:TextInputModule");

interface Note {
  id: string;
  title: string;
  excerpt: string;
  tags: string[];
  links: string[];
  wordCount: number;
  createdAt: number;
}

interface Vault {
  vaultName: string;
  stats: { noteCount: number; linkCount: number; tagCount: number };
  notes: Note[];
}

interface GrowItem {
  tr: Transform;
  target: vec3;
  start: number;
}

interface NodeRef {
  mat: Material | null;
  fullColor: vec4;
  labelObj: SceneObject | null;
  panel: Transform | null; // the TextPanel child, scaled 0 ↔ open on tap
}

interface EdgeRef {
  a: string;
  b: string;
  mat: Material | null;
  fullColor: vec4;
}

@component
export class VaultGraphRenderer extends BaseScriptComponent {
  @input
  @hint("Internet Module asset — used to GET the encrypted vault.")
  internetModule: InternetModule;

  @input
  @hint("3D object instantiated per note. Should contain a Text component (label).")
  nodePrefab: ObjectPrefab;

  @input
  @hint("Empty SceneObject the graph spawns under. Place it ~100cm in front of the camera.")
  graphRoot: SceneObject;

  @input
  @hint("Draw edges between linked notes. Requires an Edge Prefab when on.")
  drawEdges: boolean = false;

  @input
  @hint("Thin cylinder (height 1 along +Y, centered) for link edges.")
  @showIf("drawEdges", true)
  edgePrefab: ObjectPrefab;

  @input
  @hint("Edge line thickness (X/Z scale of the cylinder). Lower = thinner. Try 0.2.")
  @showIf("drawEdges", true)
  edgeThickness: number = 0.2;

  @input
  @hint("Backend base URL — the script appends /vault/<vaultId>.")
  backendUrl: string = "https://spectacles-sync-backend-production.up.railway.app";

  @input
  @hint("Cloud radius in cm — seed sphere, and the size the clustered layout is normalized to fit.")
  radius: number = 60;

  @input
  @hint("Cluster linked notes with a force-directed layout (computed once on load). Off = even sphere.")
  clusterLayout: boolean = true;

  @input
  @hint("Force-solver iterations (one-time, on load). Higher = tighter clusters, slower load. 200 suits most vaults.")
  @showIf("clusterLayout", true)
  layoutIterations: number = 200;

  @input
  @hint("Repulsion — how hard all nodes push apart. Higher = more spread out.")
  @showIf("clusterLayout", true)
  repulsion: number = 1.0;

  @input
  @hint("Link attraction — how hard linked notes pull together. Higher = tighter clusters.")
  @showIf("clusterLayout", true)
  linkAttraction: number = 1.0;

  @input
  @hint("Ideal link length multiplier — larger = more space between connected notes.")
  @showIf("clusterLayout", true)
  linkLength: number = 1.0;

  @input
  @hint("Center gravity — gentle pull to the middle so disconnected notes don't drift off.")
  @showIf("clusterLayout", true)
  centerGravity: number = 0.02;

  @input
  @hint("Node scale multiplier for a ~0-word note.")
  minNodeScale: number = 0.5;

  @input
  @hint("Node scale multiplier for the wordiest note.")
  maxNodeScale: number = 2.0;

  @input
  @hint("Target center-to-center gap (cm) between neighbouring nodes. The whole cloud is rescaled so density stays constant no matter how many notes you have — raise this if nodes still overlap or labels are unreadable.")
  nodeSpacing: number = 20;

  @input
  @hint("Material property the node color is written to. Standard PBR uses 'baseColor', but stylized graph materials use an auto-generated name — the Crafty 'Modeling Clay' material the node prefab ships with uses 'Tweak_N20'. If nodes stay one color, open the node's material in the Inspector and copy the exact name of its color property here. (baseColor/mainColor are always tried as fallbacks.)")
  nodeColorProperty: string = "Tweak_N20";

  @input
  @hint("Title label size multiplier. Labels are kept a uniform size regardless of node size; lower this if titles are too big or overlap in dense areas.")
  labelScale: number = 0.6;

  @input
  @hint("Hide a node's title past this distance (cm) from the camera, so only nodes near you are labelled — declutters dense/far clusters. 0 (default) = always show every label. The cloud usually sits ~100cm away, so use values above ~100 if you enable this.")
  labelMaxDistance: number = 0;

  @input
  @hint("Color nodes by their top-level folder (recommended — most vaults organize by folder). Off = color by first #tag. Notes with neither get a neutral grey.")
  colorByFolder: boolean = true;

  @input
  @hint("Seconds between each node appearing (cascade, in note-creation order).")
  spawnInterval: number = 0.08;

  @input
  @hint("Seconds each node takes to grow to full size as it spawns.")
  growDuration: number = 0.3;

  @input
  @hint("How dark unrelated nodes/edges go when one is selected (0 = black, 1 = no dimming).")
  dimFactor: number = 0.15;

  @input
  @hint("Milliseconds for a node's info panel (TextPanel child) to grow in/out when tapped.")
  panelTweenMs: number = 200;

  @input
  @hint("Max characters per line in the info panel — text is word-wrapped to this width (3D text has no auto-wrap). Lower = narrower column.")
  panelWrapChars: number = 28;

  @input
  @hint("Max lines in the info panel — extra text is truncated with '…'. Set to match panel height so text never spills past the bottom.")
  panelMaxLines: number = 16;

  @input
  @hint("Longest a pinch can be held and still count as a node tap. A longer/dragged pinch moves the cloud instead of selecting (prevents false clicks).")
  tapMaxSec: number = 0.35;

  @input
  @hint("How far (cm) the cloud may move during a pinch and still count as a tap. Move further than this and the pinch is treated as a drag (reposition the graph) instead of opening the card. Lower = more sensitive to drags.")
  dragThreshold: number = 2;

  @input
  @hint("Write status to an on-lens Text (decoded / fetching / decrypted / errors).")
  showDebug: boolean = false;

  @input
  @hint("Text component that shows status on-device.")
  @showIf("showDebug", true)
  debugText: Text;

  @input
  @hint("Show a masked password field (dots) as you type. Needs a Text below.")
  showPasswordField: boolean = false;

  @input
  @hint("Text component that displays the password as dots while typing.")
  @showIf("showPasswordField", true)
  passwordField: Text;

  @input
  @hint("Add a pinch button to toggle showing/hiding the typed password.")
  enableShowHide: boolean = false;

  @input
  @hint("Togglable button SceneObject (SpectaclesUIKit RectangleButton) — toggle on to reveal the password, off to hide.")
  @showIf("enableShowHide", true)
  showHideButtonObj: SceneObject;

  private camera = WorldCameraFinderProvider.getInstance();
  private labels: SceneObject[] = [];
  private done = false;
  private typedPassword = "";
  private motionController: any = null;
  private controllerWasAvailable = false;
  private revealPassword = false;

  // progressive spawn state
  private spawning = false;
  private spawnNotes: Note[] = [];
  private spawnVault: Vault | null = null;
  private spawnPositions: Record<string, vec3> = {};
  private spawnTotal = 0;
  private spawnIndex = 0;
  private spawnMaxWords = 1;
  private lastSpawnTime = 0;
  private growing: GrowItem[] = [];

  // focus/highlight state
  private nodes: Record<string, NodeRef> = {};
  private edges: EdgeRef[] = [];
  private adjacency: Record<string, Record<string, boolean>> = {};
  private selectedId: string | null = null;

  // stable category → color map; hues are spread by the golden angle so categories
  // (folders or tags) stay visually distinct no matter how many there are.
  private categoryColors: Record<string, vec4> = {};
  private categoryCount = 0;
  // Resolved once per load from the actual vault: colorByFolder is the preference,
  // but if it yields a single bucket (everything one color) and the other
  // dimension has variety, we use the other instead. See chooseColorDimension.
  private effectiveColorByFolder = true;

  // tap-vs-drag state — suppresses false node selections while moving the cloud
  private manipulating = false;
  private pressId: string | null = null;
  private pressStart = 0;
  private pressGraphPos: vec3 = vec3.zero(); // graph-root world pos when the pinch began

  // Two-hand (grab two different nodes) rotate/scale state. SIK's per-node
  // manipulation only goes two-handed when both hands grab the SAME node, so we
  // run our own gesture across two nodes and suppress the per-node translation
  // while it's active. Single-hand drag is left entirely to SIK.
  private grabs: { interactor: any; manip: any }[] = [];
  private parkedManips: any[] = []; // node manips disabled while the two-hand gesture owns the graph
  private twoHand = false;
  private thStartVec: vec3 = vec3.zero();
  private thStartDist = 1;
  private thStartRot: quat = quat.quatIdentity();
  private thStartScale: vec3 = vec3.one();
  private thPivotOffset: vec3 = vec3.zero(); // graph pos relative to the hands' midpoint at grab start

  onAwake(): void {
    print("Obsidiar Lens v" + LENS_VERSION + " — starting up.");
    if (this.debugText) this.debugText.text = "Obsidiar v" + LENS_VERSION;
    this.setupController();
    this.setupManipGuard();
    this.bindShowHideButton();
    this.createEvent("UpdateEvent").bind(() => this.onUpdate());
    this.createEvent("OnStartEvent").bind(() => {
      print("Obsidiar Lens v" + LENS_VERSION + " — ready, prompting for password.");
      this.openKeyboard("Enter your Obsidian password to load your vault.");
    });
  }

  // requestKeyboard() picks AR-vs-phone keyboard at call time. If the phone controller
  // connects AFTER launch, we must re-request so the keyboard moves to the phone.
  private setupController(): void {
    try {
      const mcModule: any = require("LensStudio:MotionControllerModule");
      const opts: any = MotionController.MotionControllerOptions.create();
      this.motionController = mcModule.getController(opts);
      this.controllerWasAvailable = this.motionController.isControllerAvailable();
    } catch (e) {
      this.motionController = null; // no controller module → AR keyboard only
    }
  }

  // While the whole cloud is being grabbed/rotated/scaled, ignore node taps so moving
  // the structure never accidentally selects a node it passes over.
  private setupManipGuard(): void {
    if (!this.graphRoot) return;
    const manip = this.graphRoot.getComponent(InteractableManipulation.getTypeName()) as InteractableManipulation;
    if (!manip) return;
    manip.onManipulationStart.add(() => {
      this.manipulating = true;
      this.pressId = null;
    });
    manip.onManipulationEnd.add(() => {
      this.manipulating = false;
    });
  }

  // --- Two-hand (two-node) rotate/scale ----------------------------------------

  private addGrab(interactor: any, manip: any): void {
    if (!interactor) return;
    for (let i = 0; i < this.grabs.length; i++) {
      if (this.grabs[i].interactor === interactor) return; // already tracked
    }
    this.grabs.push({ interactor: interactor, manip: manip });
  }

  // Toggle a node manip's translate/rotate/scale together (used to park the
  // per-node manipulators while the two-hand gesture owns the graph transform).
  private setManipEnabled(manip: any, on: boolean): void {
    if (!manip) return;
    if (manip.setCanTranslate) manip.setCanTranslate(on);
    if (manip.setCanRotate) manip.setCanRotate(on);
    if (manip.setCanScale) manip.setCanScale(on);
  }

  private removeGrab(interactor: any): void {
    if (!interactor) return;
    const kept: { interactor: any; manip: any }[] = [];
    for (let i = 0; i < this.grabs.length; i++) {
      if (this.grabs[i].interactor !== interactor) kept.push(this.grabs[i]);
    }
    this.grabs = kept;
  }

  // The world point we track for a hand, or null if the hand isn't currently
  // pinching. Crucial: isActive() only means the hand is *tracked* — it stays
  // true after release. The real "still pinching" signal is currentTrigger,
  // which drops to None (0) on release; without this check a released-but-still-
  // visible hand keeps driving the gesture. We use its origin (not the ray hit)
  // so the gesture doesn't feed back on itself as the graph moves.
  private interactorPoint(it: any): vec3 | null {
    if (!it) return null;
    if (it.isActive && !it.isActive()) return null; // hand no longer tracked
    if (it.currentTrigger !== undefined && it.currentTrigger !== null && !it.currentTrigger) {
      return null; // tracked but pinch released (currentTrigger === None)
    }
    if (it.startPoint) return it.startPoint;
    if (it.endPoint) return it.endPoint;
    return null;
  }

  // When two different nodes are held, drive the graph root's rotate/scale/move
  // from the two hand positions and suppress SIK's per-node translation so they
  // don't fight. When a hand lifts, hand control back to SIK's single-hand drag
  // (re-caching its start so the graph doesn't jump).
  private updateTwoHand(): void {
    const active: { interactor: any; manip: any }[] = [];
    for (let i = 0; i < this.grabs.length; i++) {
      const p = this.interactorPoint(this.grabs[i].interactor);
      if (p) active.push(this.grabs[i]);
    }

    if (active.length >= 2) {
      const pa = this.interactorPoint(active[0].interactor)!;
      const pb = this.interactorPoint(active[1].interactor)!;
      const tr = this.graphRoot.getTransform();

      if (!this.twoHand) {
        this.twoHand = true;
        // Stop every grabbed node's manipulation from moving the graph itself —
        // single-hand DIRECT grabs can rotate too, so disable all three, not just
        // translation, or they'd fight the gesture below. Remember exactly which
        // manips we parked so we can always re-enable them on exit, even if both
        // hands release on the same frame (which empties this.grabs first).
        this.parkedManips = [];
        for (let i = 0; i < active.length; i++) {
          const m = active[i].manip;
          if (m && this.parkedManips.indexOf(m) === -1) {
            this.parkedManips.push(m);
            this.setManipEnabled(m, false);
          }
        }
        this.thStartVec = pb.sub(pa);
        this.thStartDist = Math.max(this.thStartVec.length, 0.0001);
        this.thStartRot = tr.getWorldRotation();
        this.thStartScale = tr.getLocalScale();
        const mid = pa.add(pb).uniformScale(0.5);
        this.thPivotOffset = tr.getWorldPosition().sub(mid);
      }

      const curVec = pb.sub(pa);
      const curDist = Math.max(curVec.length, 0.0001);
      const s = curDist / this.thStartDist;
      const rotDelta = quat.rotationFromTo(this.thStartVec.normalize(), curVec.normalize());
      const curMid = pa.add(pb).uniformScale(0.5);

      tr.setWorldRotation(rotDelta.multiply(this.thStartRot));
      tr.setWorldPosition(curMid.add(rotDelta.multiplyVec3(this.thPivotOffset.uniformScale(s))));
      tr.setLocalScale(this.thStartScale.uniformScale(s));
    } else if (this.twoHand) {
      this.twoHand = false;
      // Re-allow manipulation on every manip we parked (tracked separately so a
      // simultaneous two-hand release can't strand one disabled), then re-seed the
      // still-held one from the current transform so drag resumes without a jump.
      for (let i = 0; i < this.parkedManips.length; i++) {
        this.setManipEnabled(this.parkedManips[i], true);
      }
      this.parkedManips = [];
      if (active.length === 1 && active[0].manip) {
        const m = active[0].manip;
        try {
          if (m.updateStartValues) m.updateStartValues();
          else if (m.updateStartTransform) m.updateStartTransform();
        } catch (err) {
          // manip's interactor list may be a frame stale on the handoff — worst
          // case the resume nudges; never fatal.
        }
      }
    }
  }

  private onUpdate(): void {
    this.billboardLabels();
    this.updateLabelVisibility();
    this.updateTwoHand();
    this.updateGrowing();
    this.spawnStep();
    if (!this.done && this.motionController) {
      const available = this.motionController.isControllerAvailable();
      if (available && !this.controllerWasAvailable) {
        this.openKeyboard("Enter your password on your phone."); // controller just connected
      }
      this.controllerWasAvailable = available;
    }
  }

  // Pop up the on-device (or phone) keyboard; load the vault when the user submits.
  private openKeyboard(prompt: string): void {
    this.typedPassword = "";
    if (this.passwordField) this.passwordField.text = "";
    this.status(prompt);
    const opts = new TextInputSystem.KeyboardOptions();
    opts.keyboardType = TextInputSystem.KeyboardType.Password;
    opts.returnKeyType = TextInputSystem.ReturnKeyType.Go;
    opts.onTextChanged = (text: string) => {
      this.typedPassword = text;
      this.renderPasswordField();
    };
    opts.onReturnKeyPressed = () => {
      this.loadFromPassword(this.typedPassword);
    };
    global.textInputSystem.requestKeyboard(opts);
  }

  private bindShowHideButton(): void {
    if (!this.showHideButtonObj) return;
    // SpectaclesUIKit togglable RectangleButton: reveal when toggled on, hide when off.
    const btn = this.showHideButtonObj.getComponent(RectangleButton.getTypeName()) as RectangleButton;
    if (btn) {
      btn.onValueChange.add(() => {
        this.revealPassword = btn.isOn;
        this.renderPasswordField();
      });
    }
  }

  private renderPasswordField(): void {
    if (!this.passwordField) return;
    this.passwordField.text = this.revealPassword
      ? this.typedPassword
      : maskDots(this.typedPassword.length);
  }

  // Entry point: the user's password (typed on Spectacles) re-derives the vault id +
  // key, then we fetch + decrypt + render. Same password as set in the Obsidian plugin.
  loadFromPassword(password: string): void {
    if (this.done || !password) return;
    this.handlePassword(password);
  }

  private status(msg: string): void {
    print("VaultGraphRenderer: " + msg);
    if (this.debugText) this.debugText.text = msg;
  }

  private async handlePassword(password: string): Promise<void> {
    try {
      this.status("Decrypting…");
      const vaultId = deriveVaultId(password);
      const key = deriveKey(password);
      const url = this.backendUrl.replace(/\/+$/, "") + "/vault/" + vaultId;
      const resp = await this.fetchWithRetry(url);
      // Every failure below re-opens the keyboard so the user can recover without
      // relaunching the Lens (a dead-end status line strands them with no keyboard).
      if (!resp) {
        this.openKeyboard("Can't reach the server — check your connection and try again.");
        return;
      }
      if (resp.status === 404) {
        this.openKeyboard("No vault for that password — try again (or re-sync in Obsidian).");
        return;
      }
      if (resp.status !== 200) {
        this.openKeyboard("Server error (HTTP " + resp.status + "). Try again.");
        return;
      }
      const env = JSON.parse(await resp.text()); // { nonce, ciphertext }
      const opened = nacl.secretbox.open(b64ToBytes(env.ciphertext), b64ToBytes(env.nonce), key);
      if (!opened) {
        this.openKeyboard("Wrong password — try again.");
        return;
      }
      const vault: Vault = JSON.parse(bytesToUtf8(opened));
      if (!vault.notes || vault.notes.length === 0) {
        this.openKeyboard('"' + vault.vaultName + '" has no notes yet — add notes, re-sync in Obsidian, then try again.');
        return;
      }
      this.status("Building graph… " + vault.notes.length + " notes");
      this.buildGraph(vault);
      this.done = true;
      this.hideUi(); // success → clear the password field + status, leave just the graph
    } catch (e) {
      this.openKeyboard("Something went wrong (" + e + "). Try again.");
    }
  }

  // One network retry — Spectacles Wi-Fi can drop a single request. Returns null if
  // both attempts throw, so the caller can show a recoverable error.
  private async fetchWithRetry(url: string): Promise<any> {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        return await this.internetModule.fetch(url, { method: "GET" });
      } catch (e) {
        print("VaultGraphRenderer: fetch attempt " + (attempt + 1) + " failed: " + e);
      }
    }
    return null;
  }

  private hideUi(): void {
    if (this.passwordField) this.passwordField.getSceneObject().enabled = false;
    if (this.debugText) this.debugText.getSceneObject().enabled = false;
    if (this.showHideButtonObj) this.showHideButtonObj.enabled = false;
  }

  // --- Rendering ---------------------------------------------------------------

  private buildGraph(vault: Vault): void {
    if (!this.nodePrefab || !this.graphRoot) {
      this.status("nodePrefab/graphRoot not set.");
      return;
    }
    // Spawn order = the order notes were created (oldest → newest).
    this.spawnNotes = vault.notes.slice().sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
    this.spawnVault = vault;
    this.spawnTotal = this.spawnNotes.length;
    this.spawnMaxWords = 1;
    this.spawnPositions = {};
    this.chooseColorDimension();
    for (let i = 0; i < this.spawnTotal; i++) {
      const n = this.spawnNotes[i];
      this.spawnMaxWords = Math.max(this.spawnMaxWords, n.wordCount);
      this.spawnPositions[n.id] = this.fibonacciSphere(i, this.spawnTotal, this.radius);
    }

    // Reset focus state + build bidirectional adjacency for highlighting.
    this.nodes = {};
    this.edges = [];
    this.adjacency = {};
    this.selectedId = null;
    for (let i = 0; i < this.spawnTotal; i++) {
      const n = this.spawnNotes[i];
      if (!this.adjacency[n.id]) this.adjacency[n.id] = {};
      for (let j = 0; j < n.links.length; j++) {
        const other = n.links[j];
        if (!this.spawnPositions[other]) continue;
        if (!this.adjacency[other]) this.adjacency[other] = {};
        this.adjacency[n.id][other] = true;
        this.adjacency[other][n.id] = true;
      }
    }

    // Pull linked notes into clusters (one-time force-directed relaxation),
    // then rescale to a constant density so big vaults don't crowd together.
    this.relaxLayout();
    this.normalizeSpacing();

    this.spawnIndex = 0;
    this.lastSpawnTime = getTime();
    this.spawning = true;
  }

  // Cascade: one node per spawnInterval, then edges once all nodes have grown in.
  private spawnStep(): void {
    if (!this.spawning) return;
    if (this.spawnIndex < this.spawnTotal) {
      if (getTime() - this.lastSpawnTime >= this.spawnInterval) {
        this.lastSpawnTime = getTime();
        this.spawnNode(this.spawnNotes[this.spawnIndex]);
        this.spawnIndex++;
      }
    } else if (this.growing.length === 0) {
      this.spawning = false;
      if (this.spawnVault) this.spawnEdges(this.spawnVault);
    }
  }

  private spawnNode(note: Note): void {
    const node = this.nodePrefab.instantiate(this.graphRoot);
    node.name = note.title;
    const tr = node.getTransform();
    tr.setLocalPosition(this.spawnPositions[note.id]);
    const f =
      this.minNodeScale + (this.maxNodeScale - this.minNodeScale) * (note.wordCount / this.spawnMaxWords);
    const target = tr.getLocalScale().uniformScale(f);
    tr.setLocalScale(target.uniformScale(0.01)); // start tiny, grow in
    this.growing.push({ tr: tr, target: target, start: getTime() });
    const mat = this.applyColor(node, note);
    const label = this.setLabel(node, note.title);
    // Counter the node's own scale so every title renders at one uniform,
    // readable size — otherwise wordy (big) nodes get oversized text. labelScale
    // tunes that uniform size.
    if (label) {
      const ltr = label.getSceneObject().getTransform();
      const lb = ltr.getLocalScale();
      ltr.setLocalScale(lb.uniformScale(this.labelScale / (f > 0.0001 ? f : 1)));
      // Title labels draw over the 3D nodes (998), but below an open info card
      // (form 999 / text 1000) so the card still covers labels behind it.
      this.setOverlay(label, 998);
    }

    // The node prefab carries its own info panel: TextPanel → Content (Text).
    // Start it collapsed; fill its text once, here.
    let panelTr: Transform | null = null;
    const panelObj = this.findChild(node, "TextPanel");
    if (panelObj) {
      panelTr = panelObj.getTransform();
      panelTr.setLocalScale(vec3.zero());
      this.labels.push(panelObj); // billboard the panel toward the camera, like the title label
      // Draw the card over everything: its form (background image/mesh) at 999,
      // its text at 1000, so the panel sits above the 3D nodes and the title
      // labels (998) and nothing can occlude it.
      this.setOverlay(panelObj.getComponent("Component.Image"), 999);
      this.setOverlay(panelObj.getComponent("Component.RenderMeshVisual"), 999);
      const content = this.findText(panelObj);
      if (content) {
        content.text = this.wrapText(this.panelTextFor(note), this.panelWrapChars);
        this.setOverlay(content, 1000);
      }
    }

    this.nodes[note.id] = {
      mat: mat,
      fullColor: this.colorForNote(note),
      labelObj: label ? label.getSceneObject() : null,
      panel: panelTr,
    };

    // Grab-and-drag any node to move the whole cloud: retarget this node's
    // manipulation onto the graph root, so dragging it translates/rotates the
    // entire graph (not just the one node). Requires an InteractableManipulation
    // component on the node prefab; without one single-hand drag is a no-op (the
    // centre-collider grab still works), but two-hand below still runs.
    const manip = node.getComponent(InteractableManipulation.getTypeName()) as InteractableManipulation;
    if (manip) {
      manip.setManipulateRoot(this.graphRoot.getTransform());
    }

    const it = node.getComponent(Interactable.getTypeName()) as Interactable;
    if (it) {
      // Tap vs. drag is decided on release, from two things: how long the pinch
      // was held and how far the cloud actually moved while held. We don't rely
      // on SIK's onDragStart (it fires on the slightest motion), so a brief,
      // near-still pinch always selects even if a drag technically began.
      it.onTriggerStart.add((e: any) => {
        this.pressId = note.id;
        this.pressStart = getTime();
        this.pressGraphPos = this.graphRoot.getTransform().getWorldPosition();
        this.addGrab(e ? e.interactor : null, manip); // track the hand for two-hand
      });
      it.onTriggerCanceled.add((e: any) => {
        this.pressId = null;
        this.removeGrab(e ? e.interactor : null);
      });
      it.onTriggerEnd.add((e: any) => {
        this.removeGrab(e ? e.interactor : null);
        if (this.pressId !== note.id) return; // canceled or released on another node
        this.pressId = null;
        if (this.manipulating) return; // the centre-collider grab is moving things
        const elapsed = getTime() - this.pressStart;
        const now = this.graphRoot.getTransform().getWorldPosition();
        const d = now.sub(this.pressGraphPos);
        const movedSq = d.x * d.x + d.y * d.y + d.z * d.z;
        const thr = this.dragThreshold;
        // Tap = held briefly AND the cloud barely moved. Held longer, or moved
        // past the threshold, means the pinch dragged the graph → not a select.
        if (elapsed <= this.tapMaxSec && movedSq <= thr * thr) this.selectNode(note.id);
      });
    }
  }

  // Draw a card visual over the 3D nodes: high render order + no depth test, so spheres
  // (drawn earlier, at any depth) can't hide it.
  private setOverlay(v: any, order: number): void {
    if (!v) return;
    v.setRenderOrder(order);
    if (v.mainPass) v.mainPass.depthTest = false; // Image / mesh material
    if (typeof v.depthTest === "boolean") v.depthTest = false; // Text component's own flag
  }

  // Select a node → focus it (highlight it + neighbors, dim the rest) and grow its info
  // panel in. Only one node is selected at a time: selecting a new node collapses the
  // previous panel and opens the new one; selecting the focused node again clears it.
  private selectNode(id: string): void {
    const prev = this.selectedId;
    if (prev && this.nodes[prev]) this.setPanel(this.nodes[prev], false);
    this.selectedId = prev === id ? null : id;
    if (this.selectedId && this.nodes[this.selectedId]) {
      this.setPanel(this.nodes[this.selectedId], true);
    }
    this.applyFocus();
  }

  private setPanel(ref: NodeRef, open: boolean): void {
    if (!ref.panel) return;
    const to = open ? new vec3(5, 3, 5) : vec3.zero();
    LSTween.scaleToLocal(ref.panel, to, this.panelTweenMs).start();
  }

  private applyFocus(): void {
    const sel = this.selectedId;
    const neigh = sel ? this.adjacency[sel] || {} : null;
    for (const id in this.nodes) {
      const ref = this.nodes[id];
      const on = !sel || id === sel || (neigh != null && neigh[id] === true);
      if (ref.mat) this.setMatColor(ref.mat, on ? ref.fullColor : this.dim(ref.fullColor));
      // Label enable/disable is handled per-frame in updateLabelVisibility (it
      // also factors in camera distance), so we don't set ref.labelObj here.
    }
    for (let i = 0; i < this.edges.length; i++) {
      const e = this.edges[i];
      const on = !sel || e.a === sel || e.b === sel;
      if (e.mat) this.setMatColor(e.mat, on ? e.fullColor : this.dim(e.fullColor));
    }
  }

  private dim(c: vec4): vec4 {
    return new vec4(c.x * this.dimFactor, c.y * this.dimFactor, c.z * this.dimFactor, c.w);
  }

  // --- Node info panel ---------------------------------------------------------

  private panelTextFor(note: Note): string {
    let s = note.title;
    if (note.excerpt) s += "\n\n" + note.excerpt;
    const tags = note.tags && note.tags.length ? note.tags.join(" ") + "   " : "";
    s += "\n\n" + tags + note.links.length + " links · " + note.wordCount + " words";
    return s;
  }

  // 3D Text has no wrap box, so we hard-wrap at word boundaries to a fixed column
  // width. Existing "\n" breaks (paragraph gaps) are preserved; a single word longer
  // than the column is left whole rather than chopped mid-word.
  private wrapText(s: string, maxChars: number): string {
    const out: string[] = [];
    const paras = s.split("\n");
    for (let p = 0; p < paras.length; p++) {
      const words = paras[p].split(" ");
      let line = "";
      for (let i = 0; i < words.length; i++) {
        let w = words[i];
        // Hard-break a single word longer than the column (URLs, long tags) so it
        // can't run off the right edge.
        while (w.length > maxChars) {
          if (line.length > 0) {
            out.push(line);
            line = "";
          }
          out.push(w.substring(0, maxChars));
          w = w.substring(maxChars);
        }
        if (line.length === 0) line = w;
        else if (line.length + 1 + w.length <= maxChars) line += " " + w;
        else {
          out.push(line);
          line = w;
        }
      }
      out.push(line);
    }
    // Cap height so text never spills past the bottom of a fixed panel.
    if (this.panelMaxLines > 0 && out.length > this.panelMaxLines) {
      out.length = this.panelMaxLines;
      let last = out[this.panelMaxLines - 1];
      if (last.length > maxChars - 1) last = last.substring(0, maxChars - 1);
      out[this.panelMaxLines - 1] = last + "…";
    }
    return out.join("\n");
  }

  private updateGrowing(): void {
    if (this.growing.length === 0) return;
    const now = getTime();
    const still: GrowItem[] = [];
    for (let i = 0; i < this.growing.length; i++) {
      const g = this.growing[i];
      let t = (now - g.start) / this.growDuration;
      if (t > 1) t = 1;
      const e = 1 - (1 - t) * (1 - t); // ease-out quad
      g.tr.setLocalScale(g.target.uniformScale(e < 0.01 ? 0.01 : e));
      if (t < 1) still.push(g);
    }
    this.growing = still;
  }

  private spawnEdges(vault: Vault): void {
    if (!this.drawEdges || !this.edgePrefab) return;
    const seen: Record<string, boolean> = {};
    for (let i = 0; i < vault.notes.length; i++) {
      const note = vault.notes[i];
      if (!this.spawnPositions[note.id]) continue;
      for (let j = 0; j < note.links.length; j++) {
        const other = note.links[j];
        if (!this.spawnPositions[other]) continue;
        const k = note.id < other ? note.id + "|" + other : other + "|" + note.id;
        if (seen[k]) continue;
        seen[k] = true;
        this.spawnEdge(note.id, other);
      }
    }
  }

  private spawnEdge(aId: string, bId: string): void {
    const a = this.spawnPositions[aId];
    const b = this.spawnPositions[bId];
    const edge = this.edgePrefab.instantiate(this.graphRoot);
    const tr = edge.getTransform();
    const dir = b.sub(a);
    tr.setLocalPosition(a.add(b).uniformScale(0.5));
    tr.setLocalRotation(quat.rotationFromTo(vec3.up(), dir.normalize()));
    tr.setLocalScale(new vec3(this.edgeThickness, dir.length, this.edgeThickness));

    const visual = this.findVisual(edge);
    let mat: Material | null = null;
    let fullColor = new vec4(1, 1, 1, 1);
    if (visual && visual.mainMaterial) {
      mat = visual.mainMaterial.clone();
      visual.clearMaterials();
      visual.addMaterial(mat);
      const pass: any = mat.mainPass;
      const name = this.nodeColorProperty;
      if (name && pass[name] !== undefined) fullColor = pass[name];
      else if (pass.baseColor !== undefined) fullColor = pass.baseColor;
      else if (pass.mainColor !== undefined) fullColor = pass.mainColor;
    }
    this.edges.push({ a: aId, b: bId, mat: mat, fullColor: fullColor });
  }

  private billboardLabels(): void {
    if (this.labels.length === 0) return;
    const camPos = this.camera.getWorldPosition();
    for (let i = 0; i < this.labels.length; i++) {
      const tr = this.labels[i].getTransform();
      const dir = camPos.sub(tr.getWorldPosition()).normalize();
      tr.setWorldRotation(quat.lookAt(dir, vec3.up()));
    }
  }

  // Per-frame label culling. A title shows only when it's "in focus" (no node
  // selected → all are; a node selected → just it + its neighbours) AND, when
  // nothing is selected, within labelMaxDistance of the camera. Hiding the far
  // side of the cloud is what kills the overlapping-text clutter in dense areas;
  // moving your head or the cloud reveals different labels as nodes come close.
  private updateLabelVisibility(): void {
    const sel = this.selectedId;
    const maxD = this.labelMaxDistance;
    const camPos = this.camera.getWorldPosition();
    for (const id in this.nodes) {
      const ref = this.nodes[id];
      if (!ref.labelObj) continue;
      // While a card is open it becomes the sole text: hide every floating title
      // (the selected node's and its neighbours') so none bleed over the panel —
      // the card already shows the title and its "See also" links. With nothing
      // selected, show all titles, distance-culled so the far side stays clean.
      let show = !sel;
      if (show && maxD > 0) {
        const wp = ref.labelObj.getTransform().getWorldPosition();
        const dx = wp.x - camPos.x;
        const dy = wp.y - camPos.y;
        const dz = wp.z - camPos.z;
        show = dx * dx + dy * dy + dz * dz <= maxD * maxD;
      }
      ref.labelObj.enabled = show;
    }
  }

  private fibonacciSphere(i: number, total: number, radius: number): vec3 {
    if (total <= 1) return new vec3(0, 0, -radius);
    const offset = 2 / total;
    const increment = Math.PI * (3 - Math.sqrt(5));
    const y = i * offset - 1 + offset / 2;
    const r = Math.sqrt(Math.max(0, 1 - y * y));
    const phi = i * increment;
    return new vec3(Math.cos(phi) * r * radius, y * radius, Math.sin(phi) * r * radius);
  }

  // One-time Fruchterman-Reingold relaxation: linked notes attract, all nodes repel,
  // a gentle center gravity keeps disconnected pieces from drifting off. Seeded from
  // the Fibonacci sphere (no overlaps), annealed with a cooling step, then normalized
  // to fit the radius. Runs in flat typed arrays so it stays GC-free during the load.
  private relaxLayout(): void {
    const n = this.spawnTotal;
    if (!this.clusterLayout || n < 2) return;

    const ids: string[] = [];
    const idx: Record<string, number> = {};
    const x = new Float32Array(n);
    const y = new Float32Array(n);
    const z = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const id = this.spawnNotes[i].id;
      ids.push(id);
      idx[id] = i;
      const p = this.spawnPositions[id];
      x[i] = p.x;
      y[i] = p.y;
      z[i] = p.z;
    }

    // Unique undirected edge list from adjacency.
    const ea: number[] = [];
    const eb: number[] = [];
    for (let i = 0; i < n; i++) {
      const neigh = this.adjacency[ids[i]];
      if (!neigh) continue;
      for (const j in neigh) {
        const ji = idx[j];
        if (ji === undefined || ji <= i) continue;
        ea.push(i);
        eb.push(ji);
      }
    }

    const k = (this.radius / Math.pow(n, 1 / 3)) * this.linkLength; // ideal node spacing
    const k2 = k * k;
    const dx = new Float32Array(n);
    const dy = new Float32Array(n);
    const dz = new Float32Array(n);
    const iters = this.layoutIterations;

    for (let it = 0; it < iters; it++) {
      const temp = k * (1 - it / iters); // cool down: big moves early, settle late
      for (let i = 0; i < n; i++) {
        dx[i] = 0;
        dy[i] = 0;
        dz[i] = 0;
      }

      // Repulsion between every pair: magnitude k²/d.
      for (let i = 0; i < n; i++) {
        for (let j = i + 1; j < n; j++) {
          let vx = x[i] - x[j];
          let vy = y[i] - y[j];
          let vz = z[i] - z[j];
          let d2 = vx * vx + vy * vy + vz * vz;
          if (d2 < 0.01) {
            vx = Math.random() - 0.5;
            vy = Math.random() - 0.5;
            vz = Math.random() - 0.5;
            d2 = 0.01;
          }
          const f = (this.repulsion * k2) / d2; // (k²/d) along unit dir → k²/d²
          dx[i] += vx * f;
          dy[i] += vy * f;
          dz[i] += vz * f;
          dx[j] -= vx * f;
          dy[j] -= vy * f;
          dz[j] -= vz * f;
        }
      }

      // Attraction along links: magnitude d²/k, pulling endpoints together.
      for (let e = 0; e < ea.length; e++) {
        const i = ea[e];
        const j = eb[e];
        const vx = x[i] - x[j];
        const vy = y[i] - y[j];
        const vz = z[i] - z[j];
        let d = Math.sqrt(vx * vx + vy * vy + vz * vz);
        if (d < 0.0001) d = 0.0001;
        const f = (this.linkAttraction * d) / k; // (d²/k) along unit dir → d/k
        dx[i] -= vx * f;
        dy[i] -= vy * f;
        dz[i] -= vz * f;
        dx[j] += vx * f;
        dy[j] += vy * f;
        dz[j] += vz * f;
      }

      // Center gravity + apply, clamped to the cooling temperature.
      const g = this.centerGravity;
      for (let i = 0; i < n; i++) {
        dx[i] -= x[i] * g;
        dy[i] -= y[i] * g;
        dz[i] -= z[i] * g;
        const len = Math.sqrt(dx[i] * dx[i] + dy[i] * dy[i] + dz[i] * dz[i]);
        if (len > temp && len > 0.0001) {
          const s = temp / len;
          dx[i] *= s;
          dy[i] *= s;
          dz[i] *= s;
        }
        x[i] += dx[i];
        y[i] += dy[i];
        z[i] += dz[i];
      }
    }

    // Write relaxed positions back; final scale is set by normalizeSpacing() so
    // density (not the cloud's outer radius) is what stays constant.
    for (let i = 0; i < n; i++) {
      this.spawnPositions[ids[i]] = new vec3(x[i], y[i], z[i]);
    }
  }

  // Rescale the whole cloud so the *typical* nearest-neighbour gap equals
  // nodeSpacing. Keeping spacing — rather than the outer radius — fixed means a
  // 30-note and a 500-note vault have the same local density, so nodes never
  // crowd into an unreadable blob as the vault grows (the cloud just gets
  // bigger; it's grab- and scale-able). Runs once, on load.
  private normalizeSpacing(): void {
    const n = this.spawnTotal;
    if (n < 2) return;
    const ids: string[] = [];
    for (let i = 0; i < n; i++) ids.push(this.spawnNotes[i].id);

    // Nearest-neighbour distance per node; the median resists outliers (a lone
    // disconnected note sitting far out won't skew the scale).
    const dists: number[] = [];
    for (let i = 0; i < n; i++) {
      const p = this.spawnPositions[ids[i]];
      let best = Infinity;
      for (let j = 0; j < n; j++) {
        if (j === i) continue;
        const q = this.spawnPositions[ids[j]];
        const dx = p.x - q.x;
        const dy = p.y - q.y;
        const dz = p.z - q.z;
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 < best) best = d2;
      }
      if (best < Infinity) dists.push(Math.sqrt(best));
    }
    if (dists.length === 0) return;
    dists.sort((a, b) => a - b);
    let median = dists[Math.floor(dists.length / 2)];
    if (median < 0.0001) median = 0.0001;

    const sc = this.nodeSpacing / median;
    for (let i = 0; i < n; i++) {
      const p = this.spawnPositions[ids[i]];
      this.spawnPositions[ids[i]] = new vec3(p.x * sc, p.y * sc, p.z * sc);
    }
  }

  private applyColor(node: SceneObject, note: Note): Material | null {
    const visual = this.findVisual(node);
    if (!visual || !visual.mainMaterial) return null;
    const mat = visual.mainMaterial.clone();
    visual.clearMaterials();
    visual.addMaterial(mat);
    this.setMatColor(mat, this.colorForNote(note));
    return mat;
  }

  // Tint a material regardless of which color uniform its shader uses. Standard
  // PBR exposes `baseColor`; stylized graph materials (the node sphere uses
  // Crafty "Modeling Clay", which only has `mainColor`) ignore baseColor — so we
  // set every known tint uniform that the pass actually defines. Writing only
  // when the uniform already exists avoids creating dead JS props on the pass.
  private setMatColor(mat: Material | null, c: vec4): void {
    if (!mat) return;
    const pass: any = mat.mainPass;
    if (!pass) return;
    // The configured property first (graph materials use names like 'Tweak_N20'),
    // then the common PBR/stylized names as fallbacks. Only write a uniform the
    // pass actually defines, so we never create dead JS props.
    const name = this.nodeColorProperty;
    if (name && pass[name] !== undefined) pass[name] = c;
    if (pass.baseColor !== undefined) pass.baseColor = c;
    if (pass.mainColor !== undefined) pass.mainColor = c;
  }

  // A note's "topic": its top-level folder (default) or its first tag, with the other
  // as a fallback. Notes with neither (e.g. an untagged note at the vault root) share a
  // neutral grey. Folder beats tag by default because nearly every note lives in one,
  // and folders tend to mirror the link clusters the layout already forms.
  private categoryKey(note: Note): string {
    const folder = topFolder(note.id);
    const tag = note.tags && note.tags.length ? topTag(note.tags[0]) : "";
    const primary = this.effectiveColorByFolder ? folder : tag;
    const secondary = this.effectiveColorByFolder ? tag : folder;
    return primary || secondary || "";
  }

  // Decide what to color by, from the data actually present. The colorByFolder
  // input is the preference, but a vault whose notes all sit in one folder (or
  // the root) would render as a single color — if the other dimension (tags)
  // has more distinct values, switch to it so the graph is actually varied.
  private chooseColorDimension(): void {
    const folders: Record<string, boolean> = {};
    const tags: Record<string, boolean> = {};
    for (let i = 0; i < this.spawnNotes.length; i++) {
      const note = this.spawnNotes[i];
      const f = topFolder(note.id);
      if (f) folders[f] = true;
      if (note.tags && note.tags.length) tags[topTag(note.tags[0])] = true;
    }
    let nf = 0;
    for (const _f in folders) nf++;
    let nt = 0;
    for (const _t in tags) nt++;

    let useFolder = this.colorByFolder;
    const chosen = useFolder ? nf : nt;
    const other = useFolder ? nt : nf;
    if (chosen <= 1 && other > chosen) useFolder = !useFolder;
    this.effectiveColorByFolder = useFolder;
    this.status("Coloring by " + (useFolder ? "folder (" + nf : "tag (" + nt) + " categories)");
  }

  private colorForNote(note: Note): vec4 {
    const key = this.categoryKey(note);
    if (!key) return new vec4(0.7, 0.7, 0.75, 1.0); // uncategorized → neutral grey
    let c = this.categoryColors[key];
    if (!c) {
      const hue = (this.categoryCount * 0.61803398875) % 1; // golden angle → distinct, evenly spread hues
      this.categoryCount++;
      c = this.hsvToRgb(hue, 0.6, 0.95);
      this.categoryColors[key] = c;
    }
    return c;
  }

  private hsvToRgb(h: number, s: number, v: number): vec4 {
    const i = Math.floor(h * 6);
    const f = h * 6 - i;
    const p = v * (1 - s);
    const q = v * (1 - f * s);
    const t = v * (1 - (1 - f) * s);
    let r = 0;
    let g = 0;
    let b = 0;
    switch (i % 6) {
      case 0: r = v; g = t; b = p; break;
      case 1: r = q; g = v; b = p; break;
      case 2: r = p; g = v; b = t; break;
      case 3: r = p; g = q; b = v; break;
      case 4: r = t; g = p; b = v; break;
      default: r = v; g = p; b = q; break;
    }
    return new vec4(r, g, b, 1.0);
  }

  private setLabel(obj: SceneObject, text: string): Text | null {
    const label = this.findText(obj);
    if (label) {
      label.text = text;
      this.labels.push(label.getSceneObject());
      return label;
    }
    return null;
  }

  private findText(obj: SceneObject): Text | null {
    const t = obj.getComponent("Component.Text");
    if (t) return t;
    for (let i = 0; i < obj.getChildrenCount(); i++) {
      const found = this.findText(obj.getChild(i));
      if (found) return found;
    }
    return null;
  }

  private findChild(obj: SceneObject, name: string): SceneObject | null {
    for (let i = 0; i < obj.getChildrenCount(); i++) {
      const c = obj.getChild(i);
      if (c.name === name) return c;
      const deeper = this.findChild(c, name);
      if (deeper) return deeper;
    }
    return null;
  }

  private findVisual(obj: SceneObject): RenderMeshVisual | null {
    const v = obj.getComponent("Component.RenderMeshVisual");
    if (v) return v;
    for (let i = 0; i < obj.getChildrenCount(); i++) {
      const found = this.findVisual(obj.getChild(i));
      if (found) return found;
    }
    return null;
  }
}

// --- password KDF (MUST match the Obsidian plugin's src/e2e.ts) -----------------

const KEY_ROUNDS = 20000;
const ID_ROUNDS = 4000;

function deriveBytes(input: string, rounds: number): Uint8Array {
  let h = utf8ToBytes(input);
  for (let i = 0; i < rounds; i++) {
    h = nacl.hash(h); // SHA-512 → 64 bytes
  }
  return h;
}

function deriveKey(password: string): Uint8Array {
  return deriveBytes("osv-key|" + password, KEY_ROUNDS).slice(0, nacl.secretbox.keyLength);
}

function deriveVaultId(password: string): string {
  return toHex(deriveBytes("osv-id|" + password, ID_ROUNDS).slice(0, 16));
}

// "Work/Meetings/note.md" → "Work"; a root-level "note.md" → "" (no folder).
function topFolder(id: string): string {
  if (!id) return "";
  const slash = id.indexOf("/");
  return slash === -1 ? "" : id.substring(0, slash);
}

// "#project/x" → "project", "#idea" → "idea" — collapses nested tags so a whole
// tag family shares one color.
function topTag(tag: string): string {
  let t = tag.charAt(0) === "#" ? tag.substring(1) : tag;
  const slash = t.indexOf("/");
  if (slash !== -1) t = t.substring(0, slash);
  return t;
}

function toHex(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) {
    s += (bytes[i] >> 4).toString(16) + (bytes[i] & 15).toString(16);
  }
  return s;
}

function maskDots(n: number): string {
  let s = "";
  for (let i = 0; i < n; i++) s += "•"; // •
  return s;
}

function utf8ToBytes(s: string): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < s.length; i++) {
    let c = s.charCodeAt(i);
    if (c < 0x80) {
      out.push(c);
    } else if (c < 0x800) {
      out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
    } else if (c >= 0xd800 && c <= 0xdbff) {
      const c2 = s.charCodeAt(++i);
      const cp = 0x10000 + ((c & 0x3ff) << 10) + (c2 & 0x3ff);
      out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
    } else {
      out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
    }
  }
  return new Uint8Array(out);
}

// --- base64 + UTF-8 helpers ----------------------------------------------------

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function b64ToBytes(s: string): Uint8Array {
  const out: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (let i = 0; i < s.length; i++) {
    const c = B64.indexOf(s.charAt(i));
    if (c === -1) continue;
    buffer = (buffer << 6) | c;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((buffer >> bits) & 0xff);
    }
  }
  return new Uint8Array(out);
}

function bytesToUtf8(bytes: Uint8Array): string {
  let out = "";
  let i = 0;
  while (i < bytes.length) {
    const b = bytes[i++];
    if (b < 0x80) {
      out += String.fromCharCode(b);
    } else if (b < 0xe0) {
      out += String.fromCharCode(((b & 0x1f) << 6) | (bytes[i++] & 0x3f));
    } else if (b < 0xf0) {
      const b2 = bytes[i++];
      const b3 = bytes[i++];
      out += String.fromCharCode(((b & 0x0f) << 12) | ((b2 & 0x3f) << 6) | (b3 & 0x3f));
    } else {
      const b2 = bytes[i++];
      const b3 = bytes[i++];
      const b4 = bytes[i++];
      let cp = ((b & 0x07) << 18) | ((b2 & 0x3f) << 12) | ((b3 & 0x3f) << 6) | (b4 & 0x3f);
      cp -= 0x10000;
      out += String.fromCharCode(0xd800 + (cp >> 10), 0xdc00 + (cp & 0x3ff));
    }
  }
  return out;
}
