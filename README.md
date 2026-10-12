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

- Click empty space to place the cursor (**+**), then just type. `"` makes a text region, `@` a plot.
- `:` types `:=`, `~` types `≡`, `Ctrl+.` types `→`, `Ctrl+G` makes the previous letter Greek.
- Enter finishes a region and moves the cursor below it. Drag a region to move it.
- Press **F1** for all keyboard shortcuts. **Examples** in the top bar has five worked worksheets.

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
| Opening Mathcad `.mcdx`/`.xmcd` files | ⚠️ Import works on test files built to the documented format; not yet tried on files saved by Mathcad. No export back to Mathcad. Input controls, 3-D plot details and some operators (e.g. `∈`) are reported as not imported |
| Opening SMath Studio `.sm`/`.smz` files | ⚠️ Checked on SMath's own bundled examples (numeric ones reproduce SMath's results). SMath-style symbolic work on undefined variables, nested matrices and plugin regions do not convert. No export back to SMath |
| Excel/MATLAB components, READPRN/WRITEPRN file I/O | ❌ |
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
