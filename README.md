# mathstudii

Engineering calculation worksheets in the spirit of Mathcad, with a modern interface:
type math anywhere on an A4 page, results update live, units are checked, and the
same app runs on Windows, macOS, Linux, Android, iOS and in any modern browser.

![Worksheet](docs/screenshot.png)

```
b := 300 mm          h := 500 mm
I := b·h³/12         I = cm^4        →  312 500 cm⁴
w(x) := q·x/(24·E·I)·(L³ − 2·L·x² + x³)
w(L/2) = mm          →  4.5 mm
```

## Platforms

| Platform | How it ships | Status |
|---|---|---|
| Web (Chrome, Edge, Firefox, Safari) | Static site, works offline as a PWA | Built and tested here |
| Windows 10/11 | Tauri: `.msi` and `.exe` installers | CI workflow (`release.yml`), not run yet |
| macOS (Apple Silicon and Intel) | Tauri: `.dmg` / `.app` | CI workflow, not run yet; unsigned unless you add an Apple certificate |
| Linux | Tauri: `.deb`, `.rpm`, `.AppImage` | `.deb` built here (2.98 MiB); the other formats build in CI |
| Android | Tauri Android APK, or install the PWA | CI job (unsigned APK), not run yet |
| iOS / iPadOS | Install the PWA (Share → Add to Home Screen); native build via `npm run ios:build` on a Mac | The native build needs an Apple developer team for signing |

**Why this stack:** one TypeScript codebase renders in the OS's own web view
(WebView2, WKWebView, WebKitGTK, Android WebView). That keeps native installers
around 10 MB instead of the ~150 MB an Electron app bundles, and the same build
runs on the web with no changes. The math engine runs in a Web Worker. A long
calculation, or an accidental infinite loop, never freezes the UI, and you can
interrupt it (Esc / Stop), like Mathcad's interrupt.

## Using it

- Click empty space to place the cursor (**+**), then just type. `"` makes a text region, `@` a plot,
  `` ` `` a Python region.
- `:` types `:=`, `~` types `≡`, `Ctrl+.` types `→`, `Ctrl+G` makes the previous letter Greek.
- Enter finishes a region and moves the cursor below it. Drag a region to move it.
- Press **F1** for all keyboard shortcuts. **Examples** in the top bar has worked worksheets.
- **Right-click** a region for Edit, Cut/Copy/Paste, Duplicate, Delete, *Show result in…*,
  *Copy value*, a typo fix, Disable evaluation, front/back, align (several selected),
  Format and Properties. Right-click empty paper to insert any region there, paste,
  select all or recalculate.
- **Suggestions while typing:** functions and your own variables from the first letter
  (with the signature shown inside the brackets), units after a number (`10 k` → kN,
  kN/m, kNm, kPa …) or after a unit and `/`, and after `=` the units that fit the result,
  each with the converted value.

### Design checks

A comparison on its own line is a check: `M_Ed ≤ M_Rd`, `w ≤ L/250`, `0 < x ≤ 10`
(`<=`, `>=`, `<`, `>`, `==`, `!=` work too, with or without `=` at the end). It shows
both values, **✓ OK** or **✗ NOT OK**, and the utilisation (demand / capacity) in
percent; a failing check is tinted red. Vectors are checked element by element and
report the worst. The status bar counts the checks ("12 checks OK · max 87 %" or
"1 of 12 checks fail"); click it to jump to the failing (or most utilised) one.

### Sections and materials

| Function | Gives |
|---|---|
| `section("IPE 300")` | h, b, t_w, t_f, r, A, A_vz, I_y, I_z, W_el_y, W_el_z, W_pl_y, W_pl_z, i_y, i_z, I_t, I_w, mass, g (weight per m), surface |
| `steel("S355")`, `steel("S355", 50 mm)` | f_y, f_u (EN 1993-1-1 Table 3.1, reduced above 40 mm), E, G, ν, ρ, α_T, ε |
| `concrete("C30/37")` | f_ck, f_ck_cube, f_cm, f_ctm, f_ctk_005, f_ctk_095, E_cm, ε_c1 … ε_cu3, n (EN 1992-1-1 Table 3.1) |
| `timber("C24")`, `timber("GL24h")` | f_m_k, f_t_0_k, f_t_90_k, f_c_0_k, f_c_90_k, f_v_k, E_0_mean, E_0_05, E_90_mean, G_mean, ρ_k, ρ_mean (EN 338:2016, EN 14080) |
| `rebar("B500B")` | f_yk, E_s, k, ε_uk |
| `bars(4, 16 mm)` | area of 4 Ø16 bars (804 mm²) |

Use them as objects: `s := section("HEB 200")`, then `s.W_pl_y`, `s.I_z` (names with two
subscripts display as W_pl,y). Rolled sections: IPE 80–600, HEA/HEB 100–1000,
HEM 100–600. Hollow sections of any size: `CHS 168.3x5`, `SHS 100x5`,
`RHS 200x100x6.3` (hot finished, corner radii 1.5t / t).

How the numbers are made, honestly: section properties are integrated from the real
outline (root radii and corner radii as arcs) and the torsion constants use the
catalogue formulas. They agree with the ArcelorMittal tables to within 0.3 % (I_w uses
I_z (h − t_f)²/4). Concrete values come from the EN 1992 formulas, so they are not
rounded like the table (E_cm of C30/37 is 32.8 GPa, the table says 33). Check against
the edition your project uses. The same functions work in Python regions, and the beam
section list uses this library.

### Units in results

Results without a unit after `=` are shown in practical metric units chosen from what
the quantity is, not from mathjs' guess:

| Quantity | Shown in | Example |
|---|---|---|
| force | N, kN, MN | `q*L` → 60 kN |
| moment / torque | N·m, kN·m, MN·m | `q*L^2/8` → 45 kN·m (energy made from J, W or Wh stays J) |
| line load, stiffness | N/m, kN/m, MN/m | `3 kN/dm` → 30 kN/m, `1 kN/m^2 * 3 m` → 3 kN/m |
| area load | N/m², kN/m² | `5 kN / (2 m)^2` → 1.25 kN/m² |
| stress, pressure | Pa … GPa | `M/W` → 3.6 MPa |
| unit weight | kN/m³ | `7850 kg/m^3 * 9.81 m/s^2` → 77 kN/m³ |
| length, area, I, W | mm/m/km, mm²/m², mm⁴/cm⁴/m⁴ … | deflection → 0.2571 mm, `b*h^3/12` → 312 500 cm⁴ |

The prefix keeps the number at 1 or above. Type a unit after `=` (or pick one from the
list, or right-click → *Show result in*) to choose yourself; *Automatic* goes back.
Worksheets set to US or CGS units keep mathjs' own choice.

Typos get a fix: `3 kn` says *"kn" is not defined — did you mean "kN"?* and the
right-click menu changes it. `kNm`, `Nm` and `Nmm` are accepted as moment units. The
exotic SI prefixes ronto, quecto, ronna and quetta are switched off, so a typo like
`kN/rm` is an error instead of a silent 10⁻²⁷ m. (`kn` no longer means knot: use `knot`.)

### Tables and data

- **Paste from Excel** (or any tab-separated text) onto the page, or into a table cell.
  A header row with units such as `x [m]` or `F (kN)` becomes column names and units.
  Decimal commas (`1,5`) and thousands separators (`1.234,5`) are understood, and text
  labels (`G`, `HEB 200`) stay text.
- **Import CSV… / Export CSV** in a table (comma or semicolon separated). A dropped
  `.csv` or `.tsv` file becomes a table.
- **Columns as variables** defines every named column as a vector (`x`, `F` …) for
  plots and sums.
- Right-click a vector or matrix result → **Copy as table**, then paste it into Excel
  with its unit.

### Find, replace, rename

**Ctrl+F** finds text in every region: math, text, Python, solve blocks, plots, tables,
and the expressions inside sketches, beams and CAD parts. **Ctrl+H** adds replace.

- With *ab|* (whole names), `L` matches `L` and `L^2` but not `L_cr` or `Load`, so
  **Replace all** becomes a rename.
- Right-click a definition → **Rename everywhere** does the same in one step, and one
  undo reverts it.

### Version history

A snapshot of each document is kept every 10 minutes while you work and at every save
(the newest 60, in this browser). File menu (▾) → **Version history** lists them with
their size and region count.

- **Restore** brings one back. The state just before is kept as a snapshot, so a restore
  can itself be undone.
- **Open as copy** starts a new document from that snapshot.

### Printing a calculation sheet

Format tab → **Page header & footer** puts company, logo, project, subject, document
number, revision, made / checked by and date on every page, with *Page n of N*.
Printing (Ctrl+P, or "Save as PDF" in the print dialog) leaves out the empty pages after
the content.

### Saving

- **Autosave is on by default.** Every worksheet is kept in the browser's document store
  (IndexedDB) and saved there a moment after each change. Closing the tab loses nothing.
  The chip next to the title says where things stand: *Saved in browser*,
  *Saved · file.mstd* or *Saving…*.
- **Save (Ctrl+S) asks for a location once.** After that, Save writes to the same file
  without asking, and autosave keeps that file up to date too. This works in the desktop
  app and in Chromium browsers (Chrome, Edge), and the link survives reloads.
  - After a reload, Chromium wants one click on Save before the page may write the file
    again. The chip tells you when.
  - Firefox and Safari cannot write files from a web page, so there Save keeps the
    document in the browser, and **Download a copy** in the file menu gives you a file.
- **Save as… (Ctrl+Shift+S)** picks a new file.
- The **▾ menu next to Save** lists recent documents with their linked files, and has
  *Open file…*, *Save as…* and the **Autosave** switch. Opening a file that is already
  linked continues the same document instead of making a copy.

### Format

The **Format** tab in the side panel formats the selected regions:

- font size, bold, italic, text colour and a highlight
- line thickness of sketches, plots and beam drawings

Under *Whole worksheet* the same font size and line thickness apply to everything, along
with a sans-serif or serif text font. When bigger text makes regions overlap, they are
pushed apart automatically.

### Syntax

| You type | Meaning |
|---|---|
| `x := 3 m` | definition |
| `g ≡ 9.81 m/s^2` | global definition (evaluated before everything else) |
| `x =` / `F = kN` | evaluate / evaluate and convert to a unit |
| `x := 2·3 =` | define and show |
| `f(x, y) := x^2 + y` | function |
| `i := 0 .. 10`, `t := 0, 0.1 .. 2` | range variables (iterate every expression they appear in) |
| `v[i] := i^2` | element definition (subscript, honours ORIGIN) |
| `x_max` | literal subscript (part of the name) |
| `[1, 2, 3]`, `[1; 2; 3]`, `[1, 2; 3, 4]` | row vector, column vector, matrix |
| `A'`, `A^-1`, `det(A)` | transpose, inverse, determinant |
| `3 + 4i` | complex number (`i` alone is an ordinary variable) |
| `x^2 - 1 → factor` | symbolic evaluation with a keyword |
| `integral(f(x), x, a, b)`, `diff(f(x), x)`, `sum(k^2, k, 1, n)` | calculus operators |
| `g` / `gm` | gravity 9.80665 m/s² / gram (Mathcad convention) |
| `log(x)` / `ln(x)` | base 10 / natural logarithm (Mathcad convention) |

Programs: end the first line with `:=` and indent the body (Shift+Enter for new lines):

```
fact(n) :=
  r ← 1
  for k ∈ 1 .. n
    r ← r · k
  return r
```

Supported: `if` / `else if` / `else`, `for … ∈ range|vector`, `while`, `break`,
`continue`, `return`, `try` / `on error`, and local `←` (or `<-`) including `v[k] ← …`.

### Sketches (drawing)

Press **Sketch** (or type `#` at the cursor) for a vector drawing region with lines,
polylines, rectangles, circles, arcs, arrows, dimensions, text and freehand. It also has
kinematic links, supports, joints, sliders, springs, dampers, loads, and parametric
cross-sections (rectangle, circle, tube, box, I, T, channel, angle). Snapping covers grid
points and endpoints (hold Alt to turn it off), and Shift constrains angles. A drawing has no
zoom of its own: drag the sketch's corner handle to resize it, and the drawing scales with it.
Regions below are pushed down.

- **Section properties:** give the sketch a name such as `sec`, and its closed shapes
  (solids minus holes) define `sec.A`, `sec.xc`, `sec.yc`, `sec.Ix`, `sec.Iy`, `sec.Ixy`,
  `sec.I1`, `sec.I2`, `sec.θ`, `sec.J`, `sec.Wx`, `sec.Wy`, `sec.rx`, `sec.ry` with units.
- **Parametric drawings:** any number in the Properties panel also accepts a worksheet
  expression (`h_I/2 + t_p/2`, `r cos(θ)`), so the drawing follows the math.
![Cross-section sketch](docs/sections.png)

- **Animation:** set a variable and a from/to range in the sketch's Properties, then
  press ▶ to sweep it. This is how the crank-slider example moves.

### Beams and frames

Press **Beam** for a structural analysis region: draw a beam, a continuous beam, a
truss or a plane frame, put supports and loads on it, and read the reactions and the
N, V, M and deflection diagrams right on the drawing.

**Drawing** (double-click the region to edit; the toolbar sits above it):

- **Member (B):** click point after point; a chain continues until Esc or a right-click.
  Points snap to the grid, to existing nodes, and onto members, which are split there.
- **Supports:** **Pin (P)** holds x and y, **Roller (R)** holds one direction, and
  **Fixed (X)** also holds rotation. Turn a support in the panel for walls or slopes;
  inclined rollers work.
- **Hinge (G):** click a node to let its members turn freely. A member hinged at both
  ends is a truss bar.
- **Force (F)** and **Moment (M):** click a node or any point on a member. A value field
  opens at the load: type `20` (the force unit) or any worksheet expression (`P_d`,
  `1.5 * q_k * 2 m`).
- **Line load (Q):** click a member for a full-length load, or drag along it for part of
  it. Loads can be uniform or linearly varying, and act downwards (gravity, per length of
  member) or perpendicular to the member.
- **Select (V):** drag nodes, and double-click a load to change its value. Delete removes
  the selection.

**Results:** the diagrams are drawn neatly **under the beam**, textbook style, one panel
each for N (only when there is axial force), V, M and δ. They share the beam's horizontal
scale, and dashed guide lines drop from the supports and point loads through every panel.
Values are labelled at supports, jumps and extremes. Moments are drawn on the tension side
(sagging below the line), shear and tension positive above, and deflection as it goes.

- The strip under the panels switches diagrams on and off, and **Reactions** adds the
  support reactions to the drawing.
- A frame gets one small copy of the structure per diagram, in a grid.
- **On structure** switches to the other layout: one diagram at a time, drawn on the
  members.
- The region grows to fit the panels when they first appear (regions below move down),
  and it can be resized freely afterwards. The whole drawing scales with its frame like
  a picture: structure, diagrams, text, lines and symbols together. Plots do the same
  with their text and lines. The panel lists the reactions, the extremes, the bending
stress (with a section modulus W) and the degree of static indeterminacy.

**Sections:** IPE/HEA/HEB profiles from a list, or any E, A, I and W. All four are
expressions; bare numbers mean GPa, cm², cm⁴ and cm³. Each member can have its own section.

**Back into the worksheet:** name the region (`b`) and the math below can use
- the reactions per support: `b.A.Ry`, `b.A.Rx`, `b.A.M`, `b.A.R`
- the extremes: `b.M_max`, `b.V_max`, `b.N_max`, `b.w_max`, `b.σ_max`
- for a straight beam, the functions `b.M(x)`, `b.V(x)`, `b.N(x)` and `b.w(x)`, plus the
  length `b.L`. That gives a plot of the moment line in one line, or checks at any section.

**How it is solved, and how exact it is.** The structure is solved with the direct
stiffness method: Euler–Bernoulli members, linear elastic, small displacements, so
statically determinate and indeterminate structures are handled alike.

- Supports are constraints with Lagrange multipliers, so the multipliers are the
  reactions themselves.
- Hinges are moment releases by static condensation.
- Members are split where loads sit, so each piece carries at most a linear line load.
  For such pieces the stiffness method is exact at the nodes. N, V and M along a member
  come from statics as exact polynomials, and the deflection is the exact double integral
  of M/EI. The answers therefore match the handbook formulas, not just approximate them:
  the tests check simply supported, cantilever, propped, continuous and Gerber beams
  and a truss against closed-form results, and a portal frame for equilibrium.
- **Not included:** shear deformation (Timoshenko), second-order effects (P-Δ, buckling),
  plasticity, moving loads and self-weight. Add self-weight as a line load.

**Load cases and combinations.** Side panel → *Use load cases & combinations* splits the
loads into cases (G permanent, Q imposed, wind, snow …; pick a load's case in its value
box or the side panel) and combines them with factors — numbers or worksheet
expressions such as `γ_G`. The default set is ULS 1.35 G + 1.5 Q and SLS G + Q.

- Every case and every combination is solved on its own, with factored loads. That is
  exact for a linear structure, unlike superposing sampled diagrams.
- The strip under the beam picks a case, a combination or the **envelope**: N, V and M
  over the ULS combinations, deflection over the SLS ones, sampled on the union of all
  stations with both sides of every jump. Max is drawn solid, min dashed. Loads that do
  not act in what is shown are faded; G and Q on one span are stacked.
- The worksheet gets the governing values (`b.M_max` over ULS, `b.w_max` over SLS,
  reactions from the ULS combination with the largest resultant) plus every case and
  combination on its own: `b.combos.ULS.M_max`, `b.cases.Q.A.Ry`.

**Springs and settlements.** A support can be elastic along its axis (spring k, drawn as
a coil), settle by a given amount (into the support, e.g. 10 mm down), and a fixed support
can have a rotational spring (a semi-rigid foot). Springs go into the stiffness matrix,
settlements are prescribed displacements; both are checked against closed-form results.

The **Beams and frames** example covers two structures:

- A two-span beam with factored loads, its reactions, a stress and deflection check, and
  plots of `b.M(x)` and `b.w(x)`.
- A portal frame with fixed feet under roof load and wind.
- Pattern loading: G on both spans, Q on either, three ULS combinations and the envelope.

### Python code

Press **Python** (or type `` ` `` at the cursor) for a code region. It runs real CPython
(Pyodide, compiled to WebAssembly) inside the app, with the worksheet:

- **Variables in.** Everything defined *above* the region is a Python variable, units
  included: `q := 10 kN/m` arrives as a `Quantity`. Vectors and matrices arrive as lists,
  objects (beam and CAD results) with attribute access (`b.M_max`), and worksheet
  functions are callable.
- **Variables out.** What you assign with `=` or define with `def` (outside loops and
  functions) becomes a worksheet variable for the regions below, so a Python function
  works in math regions and plots: `sigma(500 cm^3) = MPa`. Loop temporaries and names
  starting with `_` stay private.
- **Units.** Arithmetic checks dimensions (`L + 2` with `L` in metres is a `TypeError`).
  `Q(5, "kN")`, `u.mm`, `u("kN/m")` make quantities; `M.to("kN*m")` gives a plain number;
  `f"{M:.1f kN*m}"` formats one. Angles are plain numbers in radians (`u.deg` = π/180).
- **Output.** `print` shows under the code, then the exported values. Errors name the line.
  The arrow next to *Python* hides the code and keeps the results.

The honest part:

- The first run starts Python, which takes a few seconds (about 13 MB, cached after that,
  so it also works offline).
- numpy, scipy, sympy, pandas and the other packages Pyodide ships are downloaded from
  the Pyodide CDN the first time a region imports them, so that first import needs internet.
  Packages with native code that Pyodide does not ship cannot be used.
- A region that never ends (`while True:`) blocks the calculation like an endless
  worksheet loop: press *Esc* (or *Stop*) to interrupt, then fix the code.
- Quantities hold one value; for numpy work, convert with `.to(...)` first and wrap the
  result again with `Q(...)`.

### CAD parts (parametric design)

Press **CAD** (or type `&` at the cursor) for a parametric part. A part is a small
Fusion-style design: components with a feature timeline, sketches on planes or faces,
solid features with booleans, and an assembly held together by joints. It is linked to
the worksheet in both directions.

**The CAD window.** Parts are edited in a separate window next to the worksheet (a browser
window, or a native window in the desktop app). On phones and small tablets the same
workspace opens full screen in the page. Its layout follows Fusion:

- **Toolbar tabs:** Solid, Assemble, Inspect and File. While a sketch is open they become
  Sketch and Constrain, with a green **Finish sketch** button.
- **Browser** (left): components (the radio button marks the active one) with their bodies
  and sketches, occurrences and joints. Each item has a visibility toggle.
- **3-D viewport** (WebGL, Z up): drag to orbit, Shift or middle drag to pan, wheel to
  zoom at the cursor. The ViewCube's faces, edges and corners jump to views. Shaded,
  shaded-with-edges and wireframe display.
- **Dialog / properties** (right): feature and joint dialogs, or the properties and mass
  properties of the selected component, body, occurrence, joint or timeline item.
- **Timeline** (bottom): the active component's sketches and features in order. Click to
  select, double-click to edit. The marker rolls the model back (⏮ ◀ ▶ ⏭, or **Roll back
  to here**). Features can be suppressed or deleted; new ones go in at the marker.

**Modelling** (Solid tab):

- **Sketch:** click an origin plane (XY, XZ, YZ, with an optional offset expression) or any
  flat face of a body. The sketch opens looking straight at its plane. The bodies it cuts
  show as grey reference outlines, and **Project** turns them into fixed sketch geometry
  (circles come back as circles).
- **Extrude:** one side, symmetric, two sides or through all. Operations are new body,
  join, cut or intersect. Click profiles in the view to pick them and bodies to choose
  targets. Cuts go into the material automatically: both directions are tried and the one
  that removes more is kept.
- **Revolve:** about the sketch axes or any sketch line, any angle, in either direction.
- **Hole:** at sketch points — simple, counterbore or countersink, a depth or through all.
- **Pattern:** rectangular (one or two directions) or circular, of features (the copies
  repeat the boolean) or of bodies.
- **Mirror:** features or bodies, about an origin plane or a sketch plane.
- **Combine:** join, cut or intersect bodies, optionally keeping the tools.
- A dialog edits the real feature, so the model previews every change; Cancel rolls it back.

**Assemblies** (Assemble tab):

- **New component** adds a component and makes it active. **Insert copy** adds another
  occurrence of the active component.
- **Joints:** rigid, revolute, slider and cylindrical. A joint origin is either picked on
  a face (it snaps to hole and shaft centres) or chosen from a list: the component origin,
  or any sketch point or circle centre with Z along the sketch normal or a sketch axis.
  - The angle and offset are worksheet expressions, so a calculation can drive the
    mechanism. A slider drives revolute joints by hand.
  - **Flip** makes mating faces point at each other.
- **Placement:** grounded occurrences stay fixed and joints carry the rest along the joint
  tree. A joint that closes a loop which does not fit is reported, not forced.
  Unconstrained occurrences take typed positions and rotations.
- **Interference** lists overlapping occurrences with the shared volume.

**Inspect:** measure between picked points (snapping to corners, with the line drawn in
the view); **Section** cuts every body with the XY, XZ or YZ plane at any position, with
the cut faces in colour (Flip keeps the other half); mass properties of the assembly,
each component and each body (volume, mass, centre of gravity, inertia tensor); overall
size.

**Extrude options and Loft:**

- **Thin (shell):** only a wall of thickness t along the outline (inside, outside or
  centred), with a closed start (an open box), closed end, both or none (a tube).
- **Rounded or chamfered edges** at the start and/or end of an extrusion: the profile is
  offset into the material in layers (a quarter circle for a fillet) and the layers are
  joined vertex to vertex. A radius too large for the profile is refused.
- **Loft** joins the first profile of one sketch to the first profile of another, on a
  different plane, with a ruled surface (a square to a circle, for example).

**Drawings:** right-click a part → **Make a drawing**. You get a sheet (A4 or A3
landscape) with:

- front, top and side views in first-angle (ISO) or third-angle projection, plus an
  isometric view;
- visible lines solid and hidden lines dashed, with overall dimensions;
- a standard scale and an ISO 7200-style title block with the projection symbol.

The drawing follows the part. Select it to print at true scale (or save it as PDF), or
to export SVG or DXF (layers VISIBLE, HIDDEN, DIM, FRAME). The lines are the mesh's
sharp edges and the silhouettes of curved walls. Each line is tested in short pieces
against every triangle in front of it, then merged, so hidden pieces that lie under
visible lines disappear.

**The 2-D sketcher** (also used for every sketch):

- **Navigation:** the wheel zooms at the cursor, middle or right drag pans, F fits.
- **Grid and snapping:** the grid adapts to the zoom (1-2-5 steps) and grid snap is optional.
  Snaps to endpoints, midpoints, centres and curves show markers, and alignment guides
  appear when you line up with other points.
- **Typing sizes:** type while drawing to give exact sizes. For example, line → `100`
  Tab `30` Enter draws a 100 mm line at 30° with its dimensions.
- **Selecting:** drag right for window select, drag left for crossing select.
- **Sketching:** line chains, corner and centre rectangles, circles, centre and
  3-point arcs, regular polygons, slots, points and construction geometry.
  - New points snap to existing points (shared, so outlines are connected), to
    midpoints (with a midpoint relation) and onto curves.
  - Nearly horizontal or vertical lines get that constraint automatically.
  - Each tool adds the relations that keep its shape: a polygon stays regular, a slot
    stays tangent, a centre rectangle stays centred.
- **Modify:**
  - **Fillet** keeps a virtual sharp, so dimensions to the corner survive.
  - **Trim** splits at crossings and turns circles into arcs.
  - **Mirror** creates the copies with symmetry relations.
- **Constraints:** coincident, point on line/circle, horizontal, vertical, parallel,
  perpendicular, tangent, equal, midpoint, symmetric, concentric and fix.
- **Dimensions:** length, distance (aligned, horizontal, vertical, point to line), angle,
  radius and diameter. They can be driving or reference. Names are unique across the part.
- **Solver:** a Levenberg–Marquardt solver keeps every constraint while you drag
  geometry, and moves the geometry as little as possible.
- **Constraint status:** the rank of the constraint Jacobian gives the degrees of freedom.
  Under-defined geometry is drawn blue and fully defined geometry black. Conflicting
  constraints are red, and redundant ones are reported.

**Linked to the worksheet:**

- **Worksheet → part:** dimensions, extrude distances, angles, hole sizes, pattern counts,
  plane offsets, densities and joint values are all worksheet expressions (`d/2`,
  `b_p + 5 mm`, `30 deg`, `n_b`), so the design follows the calculation above it.
- **Part → worksheet:** name the part (`asm`) and the math below can use
  - the whole assembly: `asm.V`, `asm.m`, the centre of gravity `asm.xg` …, the mass moments
    of inertia `asm.Imx` … `asm.Imyz`, and the overall size `asm.Lx`, `asm.Ly`, `asm.Lz`
  - each component, `asm.Flange.m`, and each body, `asm.Flange.Body1.V`. A single-component
    part puts its bodies and sketches directly on the part.
  - each sketch's section, `asm.Disc.A`; the first sketch's section is also on the part
    itself (`shaft.A`, `shaft.Ix`, `shaft.Wx` …)
  - every named dimension (`asm.D_f`) and every moving joint (`asm.Spin` in degrees, a
    slider in length)
- **Live:** edits travel to the worksheet at once, which recalculates and sends the results
  back. Undo in the CAD window applies to the part only. The worksheet window must stay
  open, since it owns the document. The page shows the 3-D model, the first sketch, or both.

**The kernels and their accuracy.** The worksheet's values come from a B-rep kernel,
[OpenCascade](https://dev.opencascade.org/) (the WASM build made for replicad, LGPL-2.1):
arcs and circles stay true circles, cap fillets are real rolling-ball fillets, a
countersink is a true cone, and volume, centroid and inertia are surface integrals over
the exact faces. The tests check them against closed forms to 10⁻⁹ (a fillet round a
box, a torus by Pappus, a countersunk hole, a pyramid frustum loft). The kernel is big
(7 MB compressed), so it loads in the background the first time a worksheet has a CAD
part, only in the calculation worker, and is cached after that (offline too).

Until it has loaded, or where it cannot, [Manifold](https://github.com/elalish/manifold)
(WASM, Apache-2.0) builds the parts. It keeps every solid a closed 2-manifold, so
booleans never leave cracks. Curves become polygons with a vertex every 2°, so volumes of
booleaned bodies are within about 2·10⁻⁴ of the true solid (a cylinder comes out ~0.02 %
small). The values refresh by themselves once OpenCascade is ready. The CAD window's 3-D
view, section view, drawings and STL button still use the Manifold mesh for now.

**Exchange:** DXF import and export per sketch (lines, arcs, circles, points, LWPOLYLINE and
POLYLINE with bulges), and binary STL export of the assembly for 3-D printing.

The **CAD part design** example covers three things:

- It sizes a shaft from its torque and builds it, then uses its mass and inertia for the
  kinetic energy.
- A plate's hole follows the shaft.
- A flange-and-shaft assembly: a counterbored bolt pattern, a revolute joint driven by
  `φ`, and the masses of both components read back into the math, and a drawing of it.

The **CAD: shells, roundings, lofts** example has a thin-walled enclosure, a knob with a
chamfered bottom and a rounded top, and a duct lofted from a rectangle to a circle.

What it is not, honestly:

- **Edge rounding only on extrusions:** fillets and chamfers work on the start and end
  edges of an extrusion (plus sketch fillets for the side edges). You cannot pick any
  3-D edge to round yet, and there are no drafts. The B-rep kernel can do both; the
  features and picking are still to come.
- **Display still faceted:** the 3-D view and the drawings show the mesh kernel's
  solids, so drawings show circles as fine polylines. No sweeps along paths and no
  splines; lofts are ruled (straight between the two profiles).
- **STEP:** the B-rep kernel writes STEP AP214 files (bodies, components, assemblies with
  their placements) and STL from the exact surfaces, but there is no button for them yet.
- **Sketching:** sketches look straight at their plane in a 2-D editor, not in the 3-D view.
- **Face sketches:** a sketch on a face keeps that face's position from when it was made;
  it does not follow later edits.
- **Joints:** no joint limits, motion studies or contact.
- **Drawings:** only the overall sizes are dimensioned automatically. There are no section
  views on the sheet and no GD&T.

It covers parametric plates, brackets, flanges, shafts and small mechanisms tied to a
calculation. It is not a replacement for Fusion, SolidWorks or FreeCAD.

### Importing Mathcad files

**Open** (or drag onto the window) a Mathcad Prime `.mcdx` or Mathcad 11–15 `.xmcd` file.
The importer converts:
- definitions, functions, ranges, element definitions, units and matrices
- programs (`if`/`for`/`while`/`return`/`try`)
- solve blocks (including Mathcad 15 *Given … Find*), symbolic `→` with keywords
- integrals, sums, derivatives
- text, images, collapsible areas and X-Y plots

It shows a report of anything it could not convert. Results are recalculated rather than
copied, so compare them with the original. The format knowledge comes from
[mcad2py](https://github.com/ChristianCruger/mcad2py) (MIT), which documents real Prime files.
The tests use hand-built files in that structure. **It has not been run on files saved by
Mathcad itself yet**, so real-world files may hit gaps.

### Importing SMath Studio files

**Open** (or drag onto the window) an SMath Studio `.sm` file, or a compressed `.smz`.
Files from SMath 0.96 to 0.99+ are read, including both layouts of the XML. The importer converts:
- definitions, functions, units (including unit overrides), matrices, `el()` indexing, ranges and strings
- programs (`line`, `for`, `while`, `if`, `try`); `for(i:=1, i≤n, i:=i+1, …)` becomes `for i ∈ 1 .. n`
- symbolic `→` and numeric `=` evaluations, `sum`, `product`, `int`, `diff`, `solve`, `cinterp`
- text (English if the file has several languages), formula comments, pictures, collapsible areas
- 2-D plots of functions of `x` and of point matrices, including `sys(…)` lists of plot items

SMath and Mathcad differ in a few ways that the import handles:
- **Top-level loops.** In SMath a `while` or `for` on the page changes worksheet variables. Here,
  such a loop becomes a program that defines the variables used further down, so `GCD :=` followed
  by the loop. When the loop sets several of them, it runs once into `loop1` and `xn := loop1.xn`
  takes each value out.
- **Function binding.** SMath functions read variables when they are called, even ones defined after
  the function. Imported worksheets switch on **Late binding** in the toolbar for this; new
  worksheets keep Mathcad's rule (values are captured where the function is defined).
- SMath indexes from 1, so imported worksheets use ORIGIN = 1.

What does not convert: SMath's symbolic work on undefined variables (a function body
that is a vector of formulas in `x`, as in the Hessian, Jacobian and orthogonal-polynomial
examples), matrices nested inside matrices, text labels and the view (zoom and pan) of
plots, 3-D plots, `sys(…)` systems of equations, and plugin regions. Each case is listed
in the import report and marked ⚠️ on the page.

**How it was tested:** on the 18 example worksheets bundled with SMath Studio, which SMath
itself saved. Beam, Simpson, Dichotomy, Chord method, Euclidean GCD, Roman numerals, Thomas
algorithm and Gravitation acceleration reproduce the results SMath stored in the files. For
example, Beam gives support reactions of −12.4533 kN and −28.6467 kN, and its diagram draws.
The examples built on symbolic vectors do not. The automated tests (`src/importers/smath.test.ts`)
use hand-written files in the same format.

Text regions are Markdown with `$inline TeX$`, `$$display TeX$$` and live values:
`{{expr | unit}}`.

## Feature coverage compared with Mathcad

The honest answer first: Mathcad is decades of work by a large team. Matching
*all* of it is not one delivery, so this is a solid core with a clear list of
gaps. Everything marked ✅ is covered by the automated tests in
`src/engine/engine.test.ts`, or was checked in a real browser.

| Area | Status |
|---|---|
| Free-form 2-D worksheet, reading-order evaluation, global definitions | ✅ |
| Live recalculation, manual mode (F9), interrupt | ✅ |
| Units: SI/US/CGS, prefixes, derived-unit simplification, conversion, dimension errors | ✅ |
| Real/complex arithmetic, number formatting (decimals, exponent threshold, digit grouping) | ✅ |
| Range variables, iteration, element definitions, ORIGIN 0/1 | ✅ |
| User functions (Mathcad-style value capture at definition time), recursion | ✅ |
| Vectors and matrices: indexing, transpose, inverse, det, rank, trace, eigen, norms, augment/stack/submatrix, sorting | ✅ |
| Programming (if/for/while/break/continue/return/try) | ✅ |
| Numeric calculus: adaptive integrals (incl. ±∞, unit aware), derivatives up to order 5, Σ, Π | ✅ |
| Solving: `root`, `polyroots`, `lsolve`, solve blocks with `find`/`minerr`/`minimize`/`maximize`, inequality constraints, units | ✅ |
| ODEs: `rkfixed`, `Rkadapt` | ✅ |
| Statistics and distributions (normal, t, χ², F, binomial, Poisson, exponential, uniform, random) | ✅ |
| Interpolation and fitting: `linterp`, `cspline`/`interp`, `slope`/`intercept`/`line`, `polyfit`, `genfit` | ✅ |
| FFT (`fft`, `ifft`, `cfft`, `icfft`), Bessel J/Y/I/K, Γ, erf | ✅ |
| Symbolics (→): simplify, expand, factor, solve, substitute, float, series, partfrac, coeffs, Laplace and inverse Laplace, limits, (in)definite integrals, derivatives | ✅ (via nerdamer-prime) |
| Plots: X-Y (lines, points, steps, bars, log axes, units), QuickPlot, polar, 3-D surface, contour, trace readout | ✅ |
| Text with Markdown, TeX and live values, images, data tables | ✅ |
| Undo/redo, copy/paste regions, disable evaluation, separate regions, dark mode | ✅ |
| Page zoom: Ctrl+wheel / trackpad / pinch around the pointer, browser-style steps, Ctrl+0 | ✅ |
| Save/open (`.mstd` JSON), autosave, print to A4 / PDF | ✅ |
| `odesolve` solve blocks, `Pdesolve`, `Find` with matrix-valued unknowns | ❌ (use `rkfixed`/`Rkadapt`) |
| Units in symbolic results | ❌ (symbolics are unit-free) |
| Drawings: vector sketches, kinematic symbols, parametric cross-sections with exact section properties, animation | ✅ |
| Beams and plane frames: draw members, supports (pin, roller, fixed, inclined, springs, settlements), hinges, point/line/moment loads, load cases, ULS/SLS combinations and envelopes; reactions and N, V, M, deflection diagrams; results and M(x), w(x) back into the worksheet | ✅ (linear elastic, first order, no shear deformation) |
| Design checks with utilisation, steel section and material library (IPE/HEA/HEB/HEM, CHS/SHS/RHS, steel, concrete, timber, rebar) | ✅ |
| Report header/footer with page numbers, find & replace / rename, version history, Excel paste and CSV import/export | ✅ |
| CAD: Fusion-style timeline (sketches on planes/faces, extrude with thin walls and rounded/chamfered end edges, revolve, loft, hole, pattern, mirror, combine with booleans), assemblies with joints, section view, measure, mass properties back into the worksheet, 2-D drawings (views, hidden lines, title block; print, SVG, DXF), DXF in/out, STL out | ✅ (exact B-rep values; no free 3-D edge fillets, drafts or sweeps yet) |
| Opening Mathcad `.mcdx`/`.xmcd` files | ⚠️ Import works on test files built to the documented format; not yet tried on files saved by Mathcad. No export back to Mathcad. Input controls, 3-D plot details and some operators (e.g. `∈`) are reported as not imported |
| Opening SMath Studio `.sm`/`.smz` files | ⚠️ Checked on SMath's own bundled examples (numeric ones reproduce SMath's results). SMath-style symbolic work on undefined variables, nested matrices and plugin regions do not convert. No export back to SMath |
| Scripting: Python regions that read worksheet variables (with units) and export variables and functions back | ✅ (Pyodide in the browser; packages such as numpy download on first import) |
| Excel/MATLAB components, READPRN/WRITEPRN file I/O | ⚠️ Excel ranges paste into tables and CSV files import/export; no live Excel link or .xlsx files |
| WYSIWYG 2-D equation editing (typing into the rendered formula) | ❌: you type a linear form with a live preview |
| Collapsible areas, headers/footers, protected regions, track changes | ❌ |
| Special functions beyond Bessel/Γ/erf (Airy, elliptic, Fresnel, …), wavelets | ❌ |
| Native iOS build signed for the App Store | ❌: needs an Apple developer account (the PWA works today) |

## Development

```bash
npm install
npm run dev          # web app at http://localhost:1420
npm test             # engine test suite
npm run build        # production web build in dist/
npm run tauri:dev    # native desktop window (needs Rust + the platform's WebView SDK)
npm run tauri:build  # installers for the current OS
npm run android:build  # needs Android SDK + NDK; run `npx tauri android init` once
npm run ios:build      # needs macOS + Xcode; run `npx tauri ios init` once
```

Native prerequisites follow the Tauri guide: <https://tauri.app/start/prerequisites/>.
Tag a commit `v0.1.0` and push the tag to build all installers in GitHub Actions
(`.github/workflows/release.yml`). `pages.yml` deploys the web app to GitHub Pages.

### Layout

```
src/engine/   math engine (no UI): syntax, evaluation, units, numerics, CAS bridge, worker
src/model/    worksheet document model and examples
src/ui/       React interface: worksheet canvas, regions, plots, side panel
src/importers/ Mathcad .mcdx / .xmcd and SMath .sm / .smz import
src/beam/     Beam and frame analysis (no UI): model, stiffness solver, worksheet evaluation
src/ui/beam/  Beam region: editor, diagrams, properties panel
src/cad/      CAD engine (no UI): sketch model and solver, profiles, design (components, timeline,
              joints), solid kernels (OpenCascade B-rep in occ/, Manifold mesh), mass
              properties, DXF, STL, STEP
src/ui/cad/   CAD window (Fusion-style workspace, sketch canvas, WebGL scene, ViewCube, dialogs,
              window link) and the page preview
src/ui/sketch/ the drawing editor (SVG), symbols and section rendering
src/platform/ file access for Tauri, the File System Access API, and the download fallback
src-tauri/    native shell (Rust): window, dialogs, file system
```

The engine builds on [mathjs](https://mathjs.org) for expressions, units and
linear algebra, [nerdamer-prime](https://github.com/together-science/nerdamer-prime)
for symbolics and [KaTeX](https://katex.org) for typesetting. The integrator,
solvers, ODE methods, FFT, distributions and special functions are implemented
in `src/engine/numeric.ts`. Section properties (Green's theorem for polygons, closed
forms for circles) are in `src/engine/geometry.ts`.

mathstudii is an independent project and is not affiliated with PTC (Mathcad) or SMath.
