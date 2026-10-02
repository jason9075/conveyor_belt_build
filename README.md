# Warehouse Conveyor Planner · 倉儲輸送規劃器

A three.js tool for planning conveyor lines in a warehouse. Boxes enter the network at **docks** (供箱口), are distributed by **splitters** (分流器) and combined by **mergers** (集合器), and leave at **receivers** (收箱口): storage inlets, packing stations, shipping docks. **Walls** (牆壁) divide the floor into zones (receiving, shipping, …), and **wall holes** (牆壁洞口) let boxes in and out of a zone.

Place facilities and walls, then draw belts. Belt ends snap to connectors, the path comes from a Dubins-style bend–straight–bend router, and it is checked for length, incline, curvature and collisions. A per-box simulation and a steady-state analysis then report throughput and bottlenecks.

The UI is in Traditional Chinese; on-screen names are given in parentheses below.

## Getting started

Use Node.js 22 (also specified in `.nvmrc`). With nvm, run `nvm install`
and `nvm use`, then install dependencies with `npm ci`.
On NixOS or a filesystem mounted with `noexec`, use `npm ci --ignore-scripts`
instead; the project's scripts handle the native binary workaround.

```bash
just          # list all recipes
just dev      # dev server on http://localhost:8080
just test     # core unit tests (node --test, no browser needed)
just build    # production build → dist/
just preview  # serve dist/ on :8080
```

It is a pure front-end app: no backend, and layouts are saved to the browser's localStorage (use Export / Import for JSON files). `dist/` is static and uses relative paths, so it can be hosted anywhere. It must be served over HTTP, though; opening `dist/index.html` from `file://` won't load the ES modules.

## GitHub Actions

`.github/workflows/build.yml` runs on every push, pull request, or manual
workflow dispatch. It uses Node.js 22, installs locked dependencies with
`npm ci`, runs `npm test`, and builds the frontend with `npm run build`.
Successful runs save `dist/` as the `frontend-dist` artifact for 14 days;
download it from the workflow run's summary page to get the static website.
Pushes to `main` and manual workflow runs on `main` also deploy the tested
build to [GitHub Pages](https://jason9075.github.io/conveyor_belt_build/).
Pull requests and other branches only build and test; they do not deploy.

For initial setup, open the repository's **Settings → Pages** and set
**Build and deployment → Source** to **GitHub Actions**. Then push to `main`
or run the workflow manually. The `github-pages` environment and deployment
URL appear in the workflow run once the deployment succeeds.

The CI setup follows [GitHub's Node.js build and test guide](https://docs.github.com/en/actions/tutorials/build-and-test-code/nodejs).

## Features

| Feature | Description |
|---|---|
| Facilities | Dock (供箱口, boxes/min it sends), receiver (收箱口, processing limit, e.g. a packing station's speed; 0 = unlimited), splitter (1 in, 3 out), merger (3 in, 1 out). Placed in two clicks: the first fixes the floor position, moving the mouse up sets the height, the second click places it |
| Conveyor pole (貨架) | The height you pull it up to is the height of the belt connector on top (1 in, 1 out), which gives belts an upper-floor junction. Each stacked level adds 2 m |
| Stacking | Splitters and mergers stack on each other to form a second layer. Walls default to one storey (4 m); clicking an existing wall's top adds a storey |
| Walls | Two clicks draw a wall (length and height adjustable). Ends snap to existing wall ends, so corners, T-junctions and straight runs join cleanly; only crossing walls are rejected |
| Wall holes | Pick a dock hole (供箱洞口) or receiver hole (收箱洞口) from the palette and click on a wall: front or back face, any height, holes may stack. They behave like docks / receivers. Hold `Ctrl` to align with other holes' columns and rows and with facility connector heights. Clicking a hole edits its rate, position, height and face |
| 3D | Facilities can sit at any height (mezzanines, overhead runs) with support legs drawn down to whatever is below; facilities at different heights can share a footprint; belts climb between connectors at different heights |
| Multi-step belt placement | Select the start, then place a support or snap to an ending connector; ending on empty ground places a support and continues with the next segment |
| Connector snapping | Nearest open connector in screen space, with input/output compatibility checked; dragging from an input reverses the flow automatically |
| Routing | Default: bend–straight–bend (tries LSL/RSR/LSR/RSL, keeps the shortest); straight/orthogonal: L/Z/U shapes with rounded corners; curve: a single arc |
| Arcs | Hermite tangent length `4·tan(θ/4)·r`, at most 90° per arc segment |
| Alignment | Hold `Ctrl` for guidelines (connector extensions, the start's axes, and their intersections); `G` toggles a 0.5 m grid |
| Validation | Length ≤ 56 m, incline ≤ 35°, radius ≥ minimum bend radius, no collisions with facilities, walls or other belts |
| Split / re-route | Dropping a splitter or merger onto a belt cuts it in two; moving a facility re-routes its belts |
| Per-box simulation | Each box is an arc-length offset on its belt, spaced 1.2 m apart, so capacity = speed / spacing. There is one belt type: 60 boxes/min |
| Throughput analysis | Steady-state fixed-point iteration: offers propagate downstream, backpressure upstream. Splitters re-share max-min fairly (a blocked output's share goes to the others); a merger whose output is full shares it fairly among its inputs. Lists over-capacity belts, docks that can't send their full rate, and open belt ends |
| Other | Dismantle, utilisation heatmap, JSON export/import, autosave to localStorage |

## Controls

| Key | Action |
|---|---|
| `1`–`5` | Dock / receiver / splitter / merger / conveyor pole: click a position → move the mouse up for height → click to place (`R` rotates 90°, `Z`/`X` 15°; clicking onto a compatible unit stacks on it) |
| `6` | Wall: click the start, then the end (`[` `]` set the wall's base height); click an existing wall's top to add a storey |
| `7` / `8` | Dock hole / receiver hole: click on a wall (hold `Ctrl` to align) |
| `C` | Belt tool (`R` cycles routing mode, `[` `]` set the height of free ends, `Z`/`X` rotate a free end) |
| `Ctrl` (hold) | Alignment guides |
| `V` / `F` | Select (drag to move) / dismantle (clicking a hole removes only that hole) |
| Mouse | Right-click cancels, right-drag orbits; middle-drag or `WASD` pans; `Q`/`E` move the view up/down; wheel zooms |
| `Space` / `L` / `M` / `H` | Pause / labels / heatmap / help |

## Layout

```
src/core/      pure logic, no three.js; runs under node for tests
  vec.js         2D vectors
  path.js        Hermite spline paths, arc-length table, curvature
  routing.js     bend–straight–bend, orthogonal, curve, clearance leads
  guidelines.js  guidelines and grid snapping
  validate.js    length, incline and curvature rules
  world.js       facilities, wall holes, belts, connector links, collisions, split, move, save/load
  sim.js         per-box simulation
  analysis.js    steady-state throughput and bottleneck diagnosis
  catalog.js     belt, facilities (including walls, holes, poles)
  examples.js    demo warehouse
src/scene/     three.js: stage, meshes, hologram previews, world sync
src/ui/        placement state machine (controller), DOM panels
test/          node:test unit tests
```

## Assumptions and simplifications

- Planning defaults: minimum bend radius 2 m (adjustable in the toolbar), maximum incline 35°, minimum length 0.5 m.
- Facility sizes and connector positions are simplified. Facility connectors sit 1 m above their base; wall-hole heights are free.
- Height changes happen only by belts climbing (≤ 35°); there are no vertical lifts. Support legs are visual only and take no part in collisions.
- There is a single cargo type (the logistics box), no SKUs; splitters share evenly in turn and do not sort by destination.
- Moving the bottom unit of a stack does not carry the units above it.
- Theoretical throughput is a steady-state estimate. Splitters and mergers share fairly in the analysis and take turns in the simulation, which averages out the same over time.
