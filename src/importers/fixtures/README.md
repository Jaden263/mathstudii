# Real worksheets for the importer tests

Files saved by Mathcad Prime, Mathcad 14/15 and SMath Studio, used by `../real.test.ts`, which
imports each one, recalculates it and compares the results with those the program saved in the
file. Author names in document properties were blanked; nothing else was changed, except that
the pictures Mathcad 15 keeps of math regions (`<rendering>` items, unused here) were dropped
from the two `.xmcd` files to keep them small.

| File | Saved by | Source | Licence |
|---|---|---|---|
| `mcad2py-*.mcdx` | Mathcad Prime 11/12 | [ChristianCruger/mcad2py](https://github.com/ChristianCruger/mcad2py), `references/` | MIT, © 2026 Christian Cruger |
| `g431-can-timing.xmcd` | Mathcad 14 | [mindThomas/G431-ESC-MotorDriver](https://github.com/mindThomas/G431-ESC-MotorDriver), `Documentation/CAN Timing.xmcd` | MIT, © 2021 Thomas Jespersen, TKJ Electronics |
| `cs-amp-hand-calculations.xmcd` | Mathcad 15 | [junior-jl/cs-amp-sky130](https://github.com/junior-jl/cs-amp-sky130), `Hand_Calculations.xmcd` | MIT, © 2022 José Lira Junior |
| `calculix-beam.sm`, `calculix-streifen.sm` | SMath Studio 0.98 | [calculix/CalculiX-Examples](https://github.com/calculix/CalculiX-Examples), `Elements/Beam.sm`, `Streifen/Streifen.sm` | MIT, © 2017 Martin Kraska |
| `mononobe-okabe.sm` | SMath Studio | [felipecordero/retaining_wall](https://github.com/felipecordero/retaining_wall), `Mononobe-Okabe.sm` | MIT, © 2024 Felipe Cordero |

The importers were also run on about 100 further public files whose licences do not allow
copying them here (engineering course material and design calculations on GitHub and GitLab);
what they showed is fixed and covered by hand-built tests in `../real.test.ts`.
