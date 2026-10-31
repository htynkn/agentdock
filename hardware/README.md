# AgentDock Hardware

Mechanical files for the AgentDock desktop controller: the reference **PCB 3D
model** (exported from EasyEDA Pro), a parametric **two-piece printed enclosure**
(base + lid) built with [build123d](https://build123d.readthedocs.io/), and the
**acrylic front panel** outline that drops into the lid (order from JLC panel).
Everything prints on an FDM printer without supports.

```
hardware/
├── pcb/                     PCB 3D model (EasyEDA Pro STEP export)
│   └── PCB.step
├── enclosure/               Parametric enclosure project
│   ├── pcb_model.py         STEP parser: extracts board outline, holes,
│   │                        component envelopes; validates against design
│   │                        anchors (EXPECT table) and fails loudly on a
│   │                        PCB revision that breaks the enclosure
│   ├── enclosure.py         Main model: base + lid + panel, exports STEP/STL
│   │                        + panel DXF, runs dimensional + interference
│   │                        + tolerance-budget self-checks
│   ├── render.py            matplotlib preview renders (6 views)
│   ├── thickness_check.py   STL wall-thickness probe (ray casting) — reproduces
│   │                        the online "thin wall" warning and locates it
│   ├── output/              Generated: STEP/STL/DXF + pcb_report.json (git-ignored)
│   ├── render/              Generated: PNG previews (git-ignored)
│   └── pyproject.toml       uv project (Python 3.12, build123d 0.13)
└── .github/workflows/       CI: builds model headless, uploads STL/STEP/DXF + previews
```

## Enclosure design

Two printed parts + one glued panel, **no supports needed**:

* **Base** — floor + walls, 4 × Ø8 screw bosses (the two right-hand ones get a
  gusset to the +X wall), 5 longitudinal + 1 transverse rib supporting the PCB
  from below, wall openings (USB-C, toggle switch, buzzer ports, ESP32 antenna
  vents). The PCB sits in a cavity with **1.0 mm clearance per side**, so it can
  be nudged left/right until the four holes line up before driving the screws.
* **Lid** — 2.0 mm top plate carried by a 1.7 mm raised rim (which is also the
  acrylic panel seat), 3.0 mm locating lip (notched at the four posts), 4 posts
  with glued knurled nuts (**Ø3.8 bore from the post foot → cavity ceiling**, so
  the Ø3.5 nut can actually be pushed in), 3 key windows (19 × 19), Ø13.6 knob
  recess + Ø8.6 shaft hole, WS2812 light port as a **stepped** counterbore
  (Ø8 → Ø5.2 → Ø3.4), and four stiffening ribs under the plate.
* **Panel** — 1.5 mm acrylic/PC + 0.2 mm adhesive tape, glued into the rim; its
  cut-outs (3 key windows, knob, light port) are derived from the same
  parameters, so `output/Panel.dxf` is always in sync with the printed lid.

### Changes from the first printed revision

The first physical build surfaced three problems; each fix is asserted by the
build itself:

| Problem | Root cause | Fix |
|---|---|---|
| Screw holes did not line up — only half of each PCB hole visible | The PCB had ±0.5 mm of play in the cavity, but the Ø2.7 pass-hole around a Ø2.5 screw only allows ±0.1, and FDM shrink over the 86 mm hole pattern is ≈0.34 mm | Cavity clearance 0.5 → **1.0 mm**; pass-hole Ø2.7 → **Ø3.4** (±0.45); head counterbore Ø4.8 → **Ø6.0** (±0.70) + 45° lead-in cone; bosses Ø6 → **Ø8** to keep 1.0 mm of wall around the bigger counterbore |
| Lid felt floppy | Three 19 × 19 key windows split the plate into 1.64 mm strips that were only 1.6 mm thick | Plate 1.6 → **2.0 mm**; 4 mm deep ribs under the two inter-window strips (and one across the free band above them); lip 1.5 → **3.0 mm**; 1.7 mm raised rim around the top edge |
| No place for the acrylic panel | — | Rim around the top face: the panel drops inside it and ends up **flush** with the rim |

Bending stiffness of the inter-window strips (the part that made the lid feel
soft): 1.64 × 2.0 mm flat strip ≈ 1.1 mm⁴ → T-section (1.64 × 2.0 plate + a
1.0 × 4.0 rib) ≈ 25.7 mm⁴, i.e. **≈ 23× stiffer** in the same load direction,
before the thicker plate and the perimeter rim are counted.

### Fastener tolerance budget (the "holes don't line up" fix)

When the screw is driven in from below, its lateral position is pinned by the
tightest link in the chain: the PCB hole (Ø2.7 around a Ø2.5 screw = ±0.10), so
the screw follows the board. Everything else has to absorb the rest:

| Feature | Diameter | Slack per side | Absorbs |
|---|---|---|---|
| Base pass-hole | Ø3.4 | ±0.45 | PCB position in the cavity + print shrink |
| Head counterbore | Ø6.0 | ±0.70 | screw head offset |
| Lid nut cavity | Ø3.8 | ±0.65 | screw entering the glued nut |

Print shrink over the 86 mm hole pattern at 0.4 % is ≈0.34 mm (≈0.17 per side).
`enclosure.py` prints this table and fails if any slack drops below 0.35 mm.

Two failure modes are asserted by the build itself instead of being discovered
on the printing platform:

| Check | Limit | Why |
|---|---|---|
| Wall thickness (ray casting, `thickness_check.py`) | no surface thinner than 0.5 mm | shallow cones and half-millimetre rings get flagged as "thin wall" |
| Nut pass-through | a Ø3.4 probe swept from each post foot to the cavity floor must leave 0 mm³ | the Ø3.5 knurled nut has to physically enter the post; a Ø2.7 sleeve in the way is invisible to the "is the hole open?" check |
| Topology | no edge < 0.02 mm, no face < 1e-4 mm², single valid solid | resin/SLA services reject such geometry as "bad edges" |
| Rib clearance | every lid rib ≥ 0.15 mm from a key window / knob hole / light port | a rib under a key window blocks the keycap |

Key dimensions (derived from the PCB STEP at load time — not hard-coded):

| Item | Value |
|---|---|
| Outer size | 97.175 × 48.175 × 22.20 mm (base 18.50 + lid plate 2.0 + rim 1.7) |
| Cavity | 93.975 × 44.975 mm, R3.987; PCB clearance 1.0 mm per side |
| PCB | 91.975 × 42.975 × 1.586 mm, corners R2.987 |
| PCB standing height | bottom face at z = 5.0 (3.4 mm above the floor; lowest solder tips still clear the floor by 1.49 mm) |
| PCB support | 4 corner bosses + 5 longitudinal + 1 transverse rib, tops all at z = 5.0 |
| Mounting holes | 4 × Ø2.7, PCB local (1.65, 3.0) / (87.65, 3.0) / (1.65, 40.0) / (87.65, 40.0) |
| Key windows | 3 × 19 × 19 mm centered on the key stems |
| Encoder | PCB local (79.375, 31.746) — the 2026-10-27 PCB moved it 1.53 mm left of the previous (80.90, 31.75); all lid features follow the STEP, nothing is hard-coded |
| Encoder hole | Ø8.6 through + Ø13.6 × 0.8 knob skirt recess, concentric with the EC11 bushing (0.00 mm offset; Ø8.6 leaves 0.8 mm around the Ø7 bushing so hole shrink from printing cannot jam it) |
| Lid stiffening | 2.0 mm plate + 2 ribs (1.0 × 4.0) under the inter-window strips + 1 rib (1.2 × 4.0) across the free band at PCB-local y = 24.5 + 3.0 mm lip + 2.6 × 1.7 mm rim |
| Min wall thickness | 0.86 mm (Base) / 0.80 mm (Lid), zero area below 0.5 mm |
| USB-C panel opening | 9.60 × 3.86 mm, **centered on the plug cavity** |
| PCB hole pattern | 86.0 × 37.0 mm, symmetric about (44.65, 21.50) while the board is centered at (46.00, 21.50) → the pattern sits 1.35 mm left of the board centre |

### Acrylic front panel (JLC panel)

`uv run enclosure.py` also emits **`output/Panel.dxf`** (mm, layer `PANEL`) —
upload it as the panel outline + cut-outs and pick:

| Item | Value |
|---|---|
| Material | acrylic / PC, **1.5 mm** thick (1.0 mm also works: set `PANEL_T = 1.0`, the rim drops by 0.5) |
| Outline | **91.67 × 42.67 mm**, corners R2.84 |
| Cut-outs | 3 × key window **19.2 × 19.2** R2.1, knob **Ø13.8**, light port **Ø3.6** |
| Attachment | 0.2 mm 3M double-sided tape on the back (the build reserves `PANEL_TAPE`), glued into the rim |

The panel sits **inside** the 2.6 mm wide rim and ends up flush with it; the rim
locates it (0.15 mm per side), hides its edges and protects it from knocks. All
cut-outs derive from the enclosure parameters, and the build asserts every panel
opening is ≥ the corresponding lid opening, so the panel can never cover a
window. The lid's knob pocket (Ø13.6 × 0.8) and the light port stay visible
through the panel holes.

### Fasteners (hidden, screws from the bottom)

| Part | Spec | Qty |
|---|---|---|
| Pan-head screw | **M2.5 × 8** (head Ø4.6 × 1.9) | 4 |
| Knurled brass nut | **M2.5, L4.0, Ø3.5 OD** (LCSC C51938993 or equivalent) | 4 |
| Adhesive | AB (two-part epoxy) | — |
| Panel tape | 3M 300LSE class, 0.2 mm | — |

```
z = 0      base floor (screw head sunk: Ø6.0 × 2.2 counterbore)
           z = 2.2 → 3.5 45° lead-in cone Ø6.0 → Ø3.4
z = 5.0    boss tops / PCB bottom face
z = 6.586  PCB top face
z = 6.786  all four lid post feet — identical posts, length 11.71 mm
           (PCB top + 0.2 mm contact sweep; the 2026-10-27 PCB moved the
           encoder 1.53 mm left, so its metal bracket no longer sits under the
           right-top mounting hole)
z = 6.79–10.99  nut cavity Ø3.8 × 4.2, mouth at the post foot; the nut is
           pushed in only 0.2 mm until it seats against the cavity ceiling,
           i.e. it lives at z = 6.99–10.99, flush with the post foot
```

* The bore from every post foot up to the cavity ceiling is **Ø3.8, not
  Ø2.7**. An earlier revision left a Ø2.7 "screw guide" sleeve between the post
  foot and the cavity mouth; the Ø3.5 nut cannot pass it, so the posts could
  never be fitted with a nut (the screws just spun). The build now asserts nut
  pass-through (see the self-checks) and the four posts look identical from
  below: Ø4.4 mouth step + Ø3.8 bore.

* The Ø3.8 cavity leaves 0.15 mm per side around the Ø3.5 knurled nut for the
  epoxy layer; the knurl bites into the cured adhesive.
* The cavity mouth uses a **Ø4.4 × 0.8 step** (not a 45° × 0.5 chamfer): a
  chamfer leaves only 0.42 mm of sloped wall between the cone and the Ø6 post
  surface, which is thin enough to be rejected; the step leaves 0.80 mm and its
  ledge doubles as the glue reservoir. The step sits at the **post foot** on all
  four posts, i.e. right at the cavity mouth. It must be ≥ 0.5 mm deep,
  otherwise the Ø4.4↔Ø3.8 ring land itself is a 0.4 mm thin wall.
* The lid posts stay **Ø6** even though the base bosses grew to Ø8: a Ø8 lid
  post makes the foot probe (Ø8/2 + 0.3) touch the encoder's metal bracket
  (top at z = 6.09), which would lift the right-top post to z = 11.29 and drag
  all four nut cavities up with it — the M2.5 × 8 screw would then never reach
  the nut. The Ø6 post keeps all four feet on the PCB top face.
* The Ø6.0 head counterbore leaves 1.0 mm to the Ø8 boss OD, and the head has
  ±0.70 mm of lateral slack — this is what lets a slightly misaligned PCB still
  be screwed down.
* M2.5 × 8 engages ~3.2 mm (≈ 7 threads); the tip (z = 10.20) stays inside the
  through-hole nut (z = 6.99–10.99) and never bottoms out — the build asserts
  engagement ≥ 2.0 mm and a ≥ 0.5 mm gap under the tip. With the nut cavity at
  the post foot (see below), **M2.5 × 12 / × 10 overshoot the cavity ceiling**
  (tips at z = 14.20 / 12.20, ceiling at 10.99) — use **× 8**.
* Note: all four posts are now the same length and all four rest on the PCB top
  face. Up to the 2026-10-25 PCB revision the encoder sat over the right-top
  mounting hole, its metal bracket forced that post to stop at z = 11.29 (7.2 mm
  long) and all four nut cavities had to be raised to match, which is why the
  older builds needed M2.5 × 12. The 2026-10-27 PCB moved the encoder 1.53 mm
  left; the bracket is clear of the hole (its top is at z = 6.09, i.e. 0.70 mm
  below the new post feet), so that exception is gone.

### Wall openings

| Opening | Wall | Size |
|---|---|---|
| USB-C receptacle | −X | **9.60 × 3.86** — the real plug is 8.25 × 2.4 and the receptacle cavity is 8.40 × 2.66, so the opening is the cavity + 0.6 per side (0.68 mm clearance per side for the plug shell) and is centered on the **cavity axis**, not on the connector body bbox: the bbox includes the locating legs that reach down to z = 0.586, which puts its centre 0.48 mm below the plug axis |
| Toggle switch lever | +Y | **9.0 × 3.8** — sized for the SK-12E12 lever's full ±25° horizontal swing (verified by a 2 763-point sweep simulation, 0 contacts) |
| Buzzer sound ports | +X | 4 vertical slots facing the buzzer |
| ESP32 module vents | +Y | 4 slots behind the module antenna area |

## Usage

```bash
cd hardware/enclosure
uv sync                     # Python 3.12 + build123d 0.13
uv run pcb_model.py         # parse the PCB STEP, validate against anchors
uv run enclosure.py         # model + export STEP/STL + self-checks
uv run thickness_check.py output/Lid.stl --min 0.5   # locate thin walls
uv run thickness_check.py output/Base.stl --min 0.5 --top 8
uv run render.py            # PNG previews into render/
```

Generated files: `Base.step/.stl`, `Lid.step/.stl`, `Panel.stl`,
**`Panel.dxf`** (order the acrylic panel from this), `pcb_report.json`.

`uv run enclosure.py` prints a self-check report and exits non-zero on any
failure: outer dimensions, panel dimensions, single-solid check, exact boolean
interference (`PCB ∩ Base`, `PCB ∩ Lid`, `Lid ∩ Panel` must all be < 0.01 mm³),
screw passage (the Ø6.0 counterbore, the 45° cone and the Ø3.4 pass-hole must be
empty — the right-hand bosses carry a gusset across the screw area, so the holes
are cut **after** the gussets), **nut pass-through** (a Ø3.4 × full-travel probe
swept from each post foot to the cavity floor must be empty — this is what
catches a post that is too narrow for the nut), screw engagement (≥ 2.0 mm, tip
must not bottom out), the **fastener tolerance budget** (every slack ≥ 0.35 mm),
**rib clearance** (every lid rib ≥ 0.15 mm from a key window / hole), the Type-C
plug path, wall thickness and topology.

### After a PCB revision

1. Re-export the STEP from EasyEDA Pro and save it as `hardware/pcb/PCB.step`
   (dated exports may live alongside; only `PCB.step` is tracked).
2. Update the SHA-256 pin in `.github/workflows/hardware.yml`.
3. Update the `EXPECT` table in `pcb_model.py` if any anchor moved
   (board outline, holes, key/encoder positions, connector envelopes,
   **USB plug cavity**). `pcb_model.py` fails with a diff of what changed —
   update the enclosure parameters accordingly before rebuilding.

Note: `PCB.step` is ~17 MB; it is tracked because the enclosure geometry is
verified against it in CI. Dated exports (`3D_PCB1_<date>.step`) are
git-ignored.

## Printing

* Material: PLA or PETG for FDM; the STEP is also clean enough for resin/SLA
  (no degenerate edges, valid BRep — see the topology check)
* 0.2 mm layers, 3 walls, 20 % infill, **no supports**
* Base prints floor-down. The Ø6.0 counterbores sit on the bed, so the 45°
  lead-in cones print as normal cones; the two left-hand counterbores cut 0.36 mm
  into the inside of the side wall (the wall keeps 1.24 mm above them).
* Lid prints **rim-down**: the 2.6 mm wide rim frame is the only bed contact,
  the 2.0 mm plate is a flat bridge, and the lip, posts and stiffening ribs all
  grow upward — no overhangs, no supports. Wall thickness check reports 0.80 mm
  minimum.

## Assembly

1. Glue the 4 knurled nuts into the lid posts: butter the nut with AB epoxy,
   push it in **from the post foot** until it bottoms out against the cavity
   ceiling — only 0.2 mm of travel now, i.e. the nut ends up flush with the post
   foot. Threading the nut onto a spare M2.5 screw or a Ø2.5 rod makes a handy
   insertion tool — hold ~30 s until the epoxy grabs.
2. Drop the PCB into the base. The cavity is deliberately 1.0 mm larger than the
   board per side, so nudge the board until the USB-C receptacle is centred in
   its wall opening and the toggle lever has equal clearance, then check that the
   four Ø2.7 holes sit over the Ø3.4 bosses (they are visible through the
   counterbores from below).
3. Place the lid; the lip locates in the cavity, posts rest on the PCB.
4. Drive 4 × M2.5 × 8 pan-head screws **from the bottom** — heads sink into the
   Ø6.0 counterbores and the lead-in cone pulls the screw towards the pass-hole
   centre, which also drags the PCB into place. Tighten evenly (the board is
   clamped between the boss tops and the post feet, so it no longer moves).
5. Peel the tape and press the acrylic panel into the rim; it drops into the
   frame and finishes flush with the top surface. Feed the knob through the
   Ø13.8 panel hole onto the EC11 shaft last.

## CI

`.github/workflows/hardware.yml` runs the parametric build headless on every
push/PR touching `hardware/**`, runs the full self-check suite, renders the
preview images and the assembly animation, and uploads a
`agentdock-hardware-<run>` artifact containing the printable STL/STEP files, the
panel DXF, the preview PNGs and `assembly.mp4` / `assembly.gif`.
