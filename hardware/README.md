# AgentDock Hardware

Mechanical files for the AgentDock desktop controller: the reference **PCB 3D
model** (exported from EasyEDA Pro) and a parametric **two-piece enclosure**
(base + lid) built with [build123d](https://build123d.readthedocs.io/), ready
for FDM 3D printing.

```
hardware/
├── pcb/                     PCB 3D model (STEP, git-ignored — too large)
│   └── 3D_PCB1_2026-10-25.step
├── enclosure/               Parametric enclosure project
│   ├── pcb_model.py         STEP parser: extracts board outline, holes,
│   │                        component envelopes; validates against design
│   │                        anchors (EXPECT table) and fails loudly on a
│   │                        PCB revision that breaks the enclosure
│   ├── enclosure.py         Main model: base + lid, exports STEP/STL,
│   │                        runs dimensional + interference self-checks
│   ├── render.py            matplotlib preview renders (4 views + exploded)
│   ├── output/              Generated: STEP/STL + pcb_report.json (git-ignored)
│   ├── render/              Generated: PNG previews (git-ignored)
│   └── pyproject.toml       uv project (Python 3.12, build123d 0.13)
└── .github/workflows/       CI: builds model headless, uploads STL/STEP + previews
```

## Enclosure design

Two printed parts, **no supports needed**:

* **Base** — floor + walls, 4 screw bosses, rib grid supporting the PCB from
  below, wall openings (USB-C, toggle switch, buzzer ports, ESP32 antenna vents)
* **Lid** — 1.6 mm top plate with locating lip, 4 screw posts with hot-glued
  knurled nuts, 3 key windows (19 × 19), Ø13 knob recess + Ø7.6 shaft hole,
  WS2812 light funnel (Ø9 → Ø3.2)

Key dimensions (derived from the PCB STEP at load time — not hard-coded):

| Item | Value |
|---|---|
| Outer size | 96.175 × 47.175 × 20.10 mm |
| PCB | 91.975 × 42.975 × 1.586 mm, corners R2.987 |
| PCB standing height | bottom face at z = 5.0 (3.4 mm above the floor; lowest solder tips still clear the floor by 1.49 mm) |
| PCB support | 4 corner bosses + 4 longitudinal + 1 transverse rib, tops all at z = 5.0 |
| Mounting holes | 4 × Ø2.7, PCB local (1.65, 3.0) / (87.65, 3.0) / (1.65, 40.0) / (87.65, 40.0) |
| Key windows | 3 × 19 × 19 mm centered on the key stems |
| Encoder hole | Ø7.6 through + Ø13 × 0.8 knob skirt recess, concentric with the EC11 bushing (0.00 mm offset) |

### Fasteners (hidden, screws from the bottom)

| Part | Spec | Qty |
|---|---|---|
| Pan-head screw | **M2.5 × 12** (head Ø4.6 × 1.9) | 4 |
| Knurled brass nut | **M2.5, L4.0, Ø3.5 OD** (LCSC C51938993 or equivalent) | 4 |
| Adhesive | AB (two-part epoxy) | — |

```
z = 0      base floor (screw head fully sunk: Ø5.0 × 2.0 counterbore)
z = 5.0    boss tops / PCB bottom face
z = 6.586  PCB top face — 3 of the 4 lid posts rest here and clamp the board
z = 11.29  nut cavity bottom, uniform on all 4 corners (the encoder-corner
           post rests on the encoder metal bracket + 0.2 mm instead of the PCB)
z = 11.29–15.5  blind nut cavity Ø3.8 × 4.2 (nut L4.0 seats flush on the bottom)
```

* The Ø3.8 cavity leaves 0.15 mm per side around the Ø3.5 knurled nut for the
  epoxy layer; the knurl bites into the cured adhesive.
* The 45° × 0.5 mm lead-in chamfer centers the nut and catches glue squeeze-out.
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
| USB-C receptacle | −X | full connector cutout + 0.6 clearance |
| Toggle switch lever | +Y | **9.0 × 3.8** — sized for the SK-12E12 lever's full ±25° horizontal swing (verified by a 2 763-point sweep simulation, 0 contacts) |
| Buzzer sound ports | +X | 4 vertical slots facing the buzzer |
| ESP32 module vents | +Y | 4 slots behind the module antenna area |

## Usage

```bash
cd hardware/enclosure
uv sync                     # Python 3.12 + build123d 0.13
uv run pcb_model.py         # parse the PCB STEP, validate against anchors
uv run enclosure.py         # model + export STEP/STL + self-checks
uv run render.py            # PNG previews into render/
```

`uv run enclosure.py` prints a self-check report and exits non-zero on any
failure: outer dimensions, single-solid check, and exact boolean interference
(`PCB ∩ Base`, `PCB ∩ Lid` must both be < 0.01 mm³).

### After a PCB revision

1. Re-export the STEP from EasyEDA Pro and drop it in `hardware/pcb/`.
2. Update the `EXPECT` table in `pcb_model.py` if any anchor moved
   (board outline, holes, key/encoder positions, connector envelopes).
   `pcb_model.py` fails with a diff of what changed — update the enclosure
   parameters accordingly before rebuilding.

### The PCB STEP is not in git

The EasyEDA STEP export is ~17 MB, so it is git-ignored. Two places need it:

* **Locally** — just export it into `hardware/pcb/`.
* **CI** — the workflow downloads it from the GitHub release `pcb-model`
  and verifies its SHA-256. Publish/update it with:

  ```bash
  cd hardware/pcb
  sha256sum 3D_PCB1_2026-10-25.step     # must match PCB_SHA256 in the workflow
  gh release create pcb-model 3D_PCB1_2026-10-25.step \
      --title "PCB 3D model" --notes "EasyEDA Pro STEP export for CI"
  # After a PCB revision: update the asset + the PCB_SHA256 pin in
  # .github/workflows/hardware.yml
  gh release upload pcb-model 3D_PCB1_2026-10-25.step --clobber
  ```

## Printing

* Material: PLA or PETG (PETG/ABS if you will heat-set the nuts instead of gluing)
* 0.2 mm layers, 3 walls, 20 % infill, **no supports**
* Base prints floor-down; lid prints top-face-down (posts point up, nut
  cavities are then upward-facing blind holes — no overhangs beyond the 45°
  chamfer)

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
