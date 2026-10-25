# AgentDock Hardware

Mechanical files for the AgentDock desktop controller: the reference **PCB 3D
model** (exported from EasyEDA Pro) and a parametric **two-piece enclosure**
(base + lid) built with [build123d](https://build123d.readthedocs.io/), ready
for FDM 3D printing.

```
hardware/
├── pcb/                     PCB 3D model (EasyEDA Pro STEP export)
│   └── PCB.step
├── enclosure/               Parametric enclosure project
│   ├── pcb_model.py         STEP parser: extracts board outline, holes,
│   │                        component envelopes; validates against design
│   │                        anchors (EXPECT table) and fails loudly on a
│   │                        PCB revision that breaks the enclosure
│   ├── enclosure.py         Main model: base + lid, exports STEP/STL,
│   │                        runs dimensional + interference self-checks
│   ├── render.py            matplotlib preview renders (4 views + exploded)
│   ├── thickness_check.py   STL wall-thickness probe (ray casting) — reproduces
│   │                        the online "thin wall" warning and locates it
│   ├── output/              Generated: STEP/STL + pcb_report.json (git-ignored)
│   ├── render/              Generated: PNG previews (git-ignored)
│   └── pyproject.toml       uv project (Python 3.12, build123d 0.13)
└── .github/workflows/       CI: builds model headless, uploads STL/STEP + previews
```

## Enclosure design

Two printed parts, **no supports needed**:

* **Base** — floor + walls, 4 screw bosses (the two right-hand ones get a
  gusset to the +X wall), 5 longitudinal + 1 transverse rib supporting the PCB
  from below, wall openings (USB-C, toggle switch, buzzer ports, ESP32 antenna
  vents)
* **Lid** — 1.6 mm top plate with a locating lip (notched at the four posts),
  4 screw posts with glued knurled nuts, 3 key windows (19 × 19), Ø13 knob
  recess + Ø7.6 shaft hole, WS2812 light port as a **stepped** counterbore
  (Ø8 → Ø5.2 → Ø3.4)

Two failure modes are asserted by the build itself instead of being discovered
on the printing platform:

| Check | Limit | Why |
|---|---|---|
| Wall thickness (ray casting, `thickness_check.py`) | no surface thinner than 0.5 mm | shallow cones and half-millimetre rings get flagged as "thin wall" |
| Topology | no edge < 0.02 mm, no face < 1e-4 mm², single valid solid | resin/SLA services reject such geometry as "bad edges" |

Key dimensions (derived from the PCB STEP at load time — not hard-coded):

| Item | Value |
|---|---|
| Outer size | 96.175 × 47.175 × 20.10 mm |
| PCB | 91.975 × 42.975 × 1.586 mm, corners R2.987 |
| PCB standing height | bottom face at z = 5.0 (3.4 mm above the floor; lowest solder tips still clear the floor by 1.49 mm) |
| PCB support | 4 corner bosses + 5 longitudinal + 1 transverse rib, tops all at z = 5.0 |
| Mounting holes | 4 × Ø2.7, PCB local (1.65, 3.0) / (87.65, 3.0) / (1.65, 40.0) / (87.65, 40.0) |
| Key windows | 3 × 19 × 19 mm centered on the key stems |
| Encoder hole | Ø7.6 through + Ø13 × 0.8 knob skirt recess, concentric with the EC11 bushing (0.00 mm offset) |
| Min wall thickness | 0.80 mm (Lid) / 0.60 mm (Base), zero area below 0.5 mm |
| USB-C panel opening | 9.60 × 3.86 mm, **centered on the plug cavity** |
| PCB hole pattern | 86.0 × 37.0 mm, symmetric about (44.65, 21.50) while the board is centered at (46.00, 21.50) → the pattern sits 1.35 mm left of the board centre |

### Fasteners (hidden, screws from the bottom)

| Part | Spec | Qty |
|---|---|---|
| Pan-head screw | **M2.5 × 12** (head Ø4.6 × 1.9) | 4 |
| Knurled brass nut | **M2.5, L4.0, Ø3.5 OD** (LCSC C51938993 or equivalent) | 4 |
| Adhesive | AB (two-part epoxy) | — |

```
z = 0      base floor (screw head sunk: Ø4.8 × 2.0 counterbore)
z = 5.0    boss tops / PCB bottom face
z = 6.586  PCB top face — 3 of the 4 lid posts rest here and clamp the board
z = 11.29  nut cavity bottom, uniform on all 4 corners (the encoder-corner
           post rests on the encoder metal bracket + 0.2 mm instead of the PCB)
z = 11.29–15.5  blind nut cavity Ø3.8 × 4.2 (nut L4.0 seats flush on the bottom)
```

* The Ø3.8 cavity leaves 0.15 mm per side around the Ø3.5 knurled nut for the
  epoxy layer; the knurl bites into the cured adhesive.
* The cavity mouth uses a **Ø4.4 × 0.8 step** (not a 45° × 0.5 chamfer): a
  chamfer leaves only 0.42 mm of sloped wall between the cone and the Ø6 post
  surface, which is thin enough to be rejected; the step leaves 0.80 mm and its
  ledge doubles as the glue reservoir. The step must be ≥ 0.5 mm deep, otherwise
  the Ø4.4↔Ø3.8 ring land itself is a 0.4 mm thin wall.
* The Ø4.8 head counterbore keeps 0.60 mm between it and the Ø6 boss OD (Ø5.0
  leaves exactly 0.50, right at the threshold).
* M2.5 × 12 engages ~2.7 mm (≈ 5 threads); the tip stays inside the through-hole
  nut and never bottoms out. M2.5 × 10 is too short (≈ 1.4 threads), × 14 hits
  the cavity floor — use **× 12**.
* Note: the encoder-corner post cannot reach the PCB (the encoder's metal
  bracket is in the way), so all four nut cavities are raised to one height and
  that post rests on the bracket. The other three posts clamp the PCB; the
  fourth corner is held by the bracket itself.

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

`uv run enclosure.py` prints a self-check report and exits non-zero on any
failure: outer dimensions, single-solid check, exact boolean interference
(`PCB ∩ Base`, `PCB ∩ Lid` must both be < 0.01 mm³), screw passage (the Ø4.8
counterbore and Ø2.7 clearance hole must be empty — the right-hand bosses carry
a gusset across the screw area, so the holes are cut **after** the gussets),
wall thickness and topology.

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
* Base prints floor-down; lid prints top-face-down (posts point up, nut
  cavities are then upward-facing blind holes — no overhangs beyond the step
  ledge and the light-port steps, which are small circular bridges)

## Assembly

1. Glue the 4 knurled nuts into the lid posts (insert from the post bottom,
   push to the cavity floor — it seats flush automatically).
2. Drop the PCB into the base; the Ø2.7 holes align over the bosses.
3. Place the lid; the lip locates in the cavity, posts rest on the PCB.
4. Drive 4 × M2.5 × 12 pan-head screws **from the bottom** — heads sink flush
   into the Ø5.0 counterbores.

## CI

`.github/workflows/hardware.yml` runs the parametric build headless on every
push/PR touching `hardware/**`, runs the full self-check suite, renders the
preview images and the assembly animation, and uploads a
`agentdock-hardware-<run>` artifact containing the printable STL/STEP files,
the preview PNGs and `assembly.mp4` / `assembly.gif`.
