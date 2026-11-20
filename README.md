# Saibyasachi Ruhan — Portfolio

This is a simple, fast, static portfolio site built with just **HTML** and **CSS**, based entirely on the content from your resume.

## How to view

1. Open the `index.html` file directly in your browser, or
2. Serve the folder with any static file server (for example, using VS Code / Cursor extensions or `python -m http.server`).

## Where to customize

- **LinkedIn & GitHub links**
  - In `index.html`, search for `TODO: Replace # with your actual links`.
  - Replace the `href="#"` values with your real profile URLs, e.g.:
    - `https://www.linkedin.com/in/your-handle`
    - `https://github.com/your-handle`

- **Hero tagline / About copy**
  - Update the hero subtitle and the text in the **About** section to better match your personal story or target roles.

- **Projects**
  - The **Projects** section currently includes:
    - Climatrack
    - File Box
    - Shoe Finder
  - Add live links or GitHub links to each project by wrapping titles or adding buttons if you deploy them.

- **Colors & styling**
  - All styling lives in `styles.css`.
  - You can tweak the theme by editing the CSS `:root` variables at the top of the file.

## Structure

- `index.html` — Markup for all sections (hero, about, skills, experience, projects, education, contact).
- `styles.css` — Modern, responsive styling (dark theme, cards, grid layout).
- `README.md` — This guide.


## Space exploration easter egg

Clicking the astronaut helmet on the home screen flies through its visor into
a real-time 3D universe simulator. The only hint on the page is that the cursor
changes and the visor brightens slightly on hover. A **Return to portfolio**
button is always on screen, and returning restores the page as it was.

The simulator is an original implementation, built for this portfolio. It
doesn't use code, assets or branding from any other space software.

### What's in it

- **Solar System.** The Sun, all planets and 32 moons (Phobos, Deimos, the
  Galilean moons, Amalthea, Himalia, Titan and the other major Saturnian moons
  including Hyperion and Phoebe, the Uranian moons and Puck, Triton, Proteus,
  Nereid, and Pluto's Charon, Styx, Nix, Kerberos and Hydra), plus Pluto,
  Ceres, Eris, Haumea, Makemake, Vesta, Pallas, Hygiea and four comets. Earth
  is the WGS 84 ellipsoid (6378.137 × 6356.752 km).
  - Positions come from JPL orbital elements for the current date, the Moon
    from a truncated lunar theory.
  - Spin axes and rotation use IAU rotation elements, so Saturn's rings tilt
    correctly and the Moon keeps its near side toward Earth.
  - Earth has day and night maps, clouds, ocean glint and a ray-marched
    atmosphere you can fly down into.
- **Stars.** 12,500 real stars: the HYG database (everything brighter than
  magnitude 6.5, or within 25 pc), plus Gaia DR3's census of the 20 pc
  neighbourhood. Beyond the catalogues, stars stream in procedurally around
  the camera.
- **Exoplanets.** All 6,451 confirmed planets from the NASA Exoplanet Archive,
  shown in their real systems with catalogue values.
- **Your spacecraft.** An original interceptor, modelled entirely in code in
  `space/craft/spacecraft.js`, with no external model files. It's about
  32 m long, 24 m across the wings and 5.7 m tall. The hull is lofted from
  custom cross-sections: a chined fuselage with a long drooped nose, a
  physical-glass canopy, low swept wings with layered armour and canted
  wingtip stabilisers, twin tail fins and ventral strakes. Side parts are
  built once and mirrored, then merged into one mesh per material (about
  3,100 triangles, 12 draw calls). It has two wing-root engines and a
  centre engine, each with a recessed nozzle, a white-blue core and a short
  cyan plume. They glow faintly at idle, turn blue under thrust and go
  white-hot on boost. The craft banks into turns. The view starts in third
  person, framed from the craft's real bounds so the wingspan fills a set
  share of the screen on any aspect ratio. `C` glides into the cockpit,
  then to a free observer while the craft holds station.
- **Galaxies.** About 900 real galaxies from the Updated Nearby Galaxy Catalog,
  plus landmarks from NED (M87, the Virgo and Fornax members, Cartwheel, Coma,
  among others), drawn as 3D particle structures. The Milky Way is modelled
  from published arm and bar positions, and you can fly into and out of it.
  A background layer adds 32,591 more from HyperLEDA (every galaxy brighter
  than B = 15.5 with a distance), with their measured position angles, loaded
  after start-up. Beyond about 40 Mly, procedural galaxies fill space along a
  cosmic-web density field.
- **Nebulae, clusters and compact objects.** Nebulae, open and globular
  clusters, black holes (Sagittarius A\*, M87\*, Cygnus X-1, Gaia BH1–3) and
  neutron stars, all at catalogued positions. Black holes have accretion discs
  and approximate lensing; neutron stars have pulsar beams.
- **Procedural star systems.** Deterministic stars, planets, moons, rings and
  asteroid belts, with discovery messages. You can give a discovered system a
  local, unofficial name.
- **Navigation.**
  - Free camera, plus a craft with chase and cockpit views.
  - Auto-travel that scales from metres to megaparsecs.
  - Search covers planets, stars (including Bayer names such as
    "Alpha Centauri"), exoplanets, galaxies (including Messier aliases),
    groups, nebulae and your discoveries.
  - Orbit lines, labels and a simulation clock from paused up to 1 year/s.
- **Launch from Earth.** Every visit starts on an original launch pad,
  simulated around the real coordinates of Kennedy Space Center LC-39A
  (28.6083° N, 80.6042° W), at a morning hour. A 15 s real-time ascent flies
  the craft itself through the actual scene: systems online, thrust, liftoff,
  climb through the cloud deck, upper atmosphere, then a 400 km low Earth
  orbit, where control passes to you. The ascent is time-compressed (a real
  one takes about eight minutes); the speed readout shows a real ascent's
  speed at each height. `SKIP LAUNCH`, `Space` or `Esc` jumps straight to
  orbit. With reduced motion it takes 7 s with no shake.
- **Cockpit.** `C` glides into a modelled cockpit whose eye point sits under
  the same canopy you see from outside: instrument panel, glare shield, side
  consoles, throttle, stick, seat, and the canopy frame fitted to the glass.
  Three screens (NAVIGATION, FLIGHT, SHIP) are live canvas textures. A HUD
  combiner draws a conformal pitch ladder (its horizon lies on the real one),
  heading, roll, speed, altitude, target and landing guidance.
- **Banking.** Turning rolls the craft into the turn, left wing down for a
  left turn, up to about 40°, and it levels itself on a damped spring when
  the turn ends. In an atmosphere the bank is real and follows the
  coordinated-turn law, tan φ = v·ω/g, so it grows with airspeed. In vacuum
  it's a visual cue only. `Z` / `X` roll by hand and override it. The chase
  camera takes up about a fifth of the roll near a body; the cockpit rolls
  fully, and the HUD keeps the true horizon.
- **Surfaces: landing and walking.** Every solid body in the catalogue can be
  landed on and walked on.
  - Below 20 km, `L` engages landing assist: it levels the craft, kills drift,
    lowers the gear and descends at a constant 4 m/s² down to a 1.2 m/s
    touchdown. The surface panel shows altitude, vertical speed, surface
    speed and a SAFE / UNSAFE verdict (too fast, not level, or water).
  - Once landed, `Enter` steps outside. Walk with `WASD`, run with `Shift`,
    jump with `Space`. Gravity is each body's real surface gravity, so the
    same push jumps about 0.5 m on Earth, 1.3 m on Mars, 3 m on the Moon and
    16 m on Ceres. A suit HUD appears where the air isn't breathable. The
    craft stays where you left it; `E` within 30 m boards it.
  - Gas and ice giants have no surface and no LAND action. `Q` descends into
    the cloud decks, which close around you and darken with depth, down to a
    pressure limit about 150 km (Jupiter, Saturn) or 100 km (Uranus, Neptune)
    below the 1-bar level. Altitudes there are measured from the oblate 1-bar
    surface.
  - Venus is a dim, dense yellow-grey haze at the surface, Titan an orange
    one. Mars has a butterscotch sky from suspended dust (optical depth 0.5).
- **Open-data 3D Earth.** Five region packs add real local detail on top of
  the global Earth: Kennedy Space Center and Cape Canaveral (the launch
  region, loaded before the launch), Manhattan with the facing shores of New
  Jersey, Brooklyn and Queens, the Grand Canyon, Mount Rainier, and Mount
  Everest. Each pack combines:
  - real terrain from USGS 3DEP (10–30 m) or Copernicus GLO-30 for Everest,
    joined into the Earth's surface model, so the canyon, the volcano and
    the coast are geometry, and landing and walking use them;
  - aerial imagery (USDA NAIP; Blue Marble NG at 500 m for Everest) draped
    on that terrain;
  - real buildings, roads, paths, rail, runways and lakes from OpenStreetMap,
    streamed in 0.01° tiles around you and ahead of you, at three levels of
    detail. Each tile's buildings are extruded from their real footprints
    (holes and building parts included) to their real or estimated heights.
    One batched mesh per tile, built in a Web Worker. Roads are draped on
    the terrain; bridges span their ends.

  You can't walk through buildings, and named places from the map data are
  labelled and searchable. Facades are procedural (window rhythm by building
  type): this is real geography and real footprints, not photogrammetry.
  Outside the packs, Earth is the global grid and imagery, with no invented
  cities.
- **Real terrain on other worlds.** Mercury (MESSENGER), Venus (Magellan),
  Ceres and Vesta (Dawn), Pluto and Charon (New Horizons) now have real
  global elevation, alongside the Moon (LOLA) and Mars (MOLA). Higher-resolution
  patches cover Tycho, Copernicus and the Apollo 11/17 sites on the Moon, and
  Olympus Mons, Valles Marineris, Hellas, Gale and Jezero on Mars.
  Elevation and imagery share one projection. Mercury's map turned out to be
  centred half a turn round, and is now sampled correctly (see
  `CREDITS.md`). Where only part of a body was mapped (Pluto and Charon about
  46%, Venus 92%), the unmapped part is filled procedurally and labelled.
- **Landmarks and map.** Search finds real places as well as worlds: Kennedy
  Space Center, Everest, the Grand Canyon, Mauna Kea, the Dead Sea and
  Challenger Deep; the Apollo 11 and 17 sites, Tycho, Copernicus and
  Shackleton; Olympus Mons, Gale, Jezero, Hellas and Valles Marineris. `G`
  routes around the limb if the site is on the far side and arrives 2 km
  above it. `T` opens the world's global map with your position and its
  landmarks; click one to select it.

### Controls

| Key | Action |
| --- | --- |
| Drag (or `M` for mouse-look; `Esc` releases) | Look around |
| `W` `A` `S` `D` / `Q` `E` / `Z` `X` | Move / down–up / roll |
| Mouse wheel | Trim travel speed. Speed also adapts to the nearest surface. |
| `Shift` / `Ctrl` or `Alt` | Boost ×10 / precision ×0.1. While Ctrl is held the page asks before closing, because browsers won't let a page block Ctrl+W. |
| Click, then `G` / `F` | Select, then travel to it / face it |
| `/` | Search |
| `C` | Camera: third person → cockpit → free observer |
| `O` / `K` / `I` | Orbit lines / labels / info panel |
| `L` | Landing assist (below 20 km over a solid body) |
| `Enter` / `E` | Step out of the landed craft / board it again (within 30 m) or lift off |
| On foot: `WASD`, `Shift`, `Space` | Walk, run, jump |
| `Space` or `Esc` during launch | Skip to orbit |
| `T` | Surface map of the world you're at |
| `P` / `,` `.` / `N` | Pause / slower or faster time / back to now |
| `R` / `H` / `Esc` | Stabilise roll / help / close panels |
| `F3` / `F4` / `F5` | Developer overlay (including the surface fields) / level-of-detail colours / craft bounds, forward vector and anchors |

On touch screens there's a virtual stick, plus buttons for up, down, speed,
go and camera mode. Keyboard controls are ignored while you're typing in
search.

### Real vs. procedural

Every object is labelled **REAL · CATALOGUED** or **SIMULATED · PROCEDURAL**.
Real objects show catalogue values. Missing values read *Unknown*, and values
derived for real stars (temperature from colour, radius, mass) are marked
*(est.)*. A real exoplanet's surface is a *procedural interpretation*, and the
info panel says so. Nebula, cluster and galaxy structures are procedural
visualisations at catalogued positions and sizes. Black-hole lensing and
accretion discs are visual approximations. Speeds above light speed are a
navigation convenience, labelled as "warp navigation · simulation".

Surfaces are labelled the same way. The surface panel shows, for the spot
you are standing on, which dataset gives the geometry, its resolution, and
(on partly mapped worlds) whether that spot was actually measured. Each body
has a data class in `space/data/surfaces/manifest.json`:

| Class | Meaning | Bodies |
| --- | --- | --- |
| A | Real global DEM + real global imagery | Earth, Moon, Mars, Mercury, Ceres, Vesta, Phobos (HRSC shape grid) |
| B | Real DEM or shape model, partial coverage or coarse grid (rest procedural, labelled) | Venus (92%), Pluto (~46%), Charon (~46%), Enceladus (Cassini shape model, 93%), Deimos and Hyperion (Thomas 5° shape models) |
| C | Real shape + real imagery, **no published DEM**: relief is procedural, held to the body's typical relief, plus labelled reconstructed features | Io, Europa, Ganymede, Callisto, Titan, Mimas, Tethys, Dione, Rhea, Iapetus, Triton |
| D | Real size/shape only, procedural surface | Haumea (Ortiz 2017 ellipsoid), Makemake, Eris, the Uranian moons (Gazetteer craters reconstructed), the small moons, asteroids, comets |

**Reconstructed features.** Where no DEM exists, `features.json` places
craters, paterae, seas and coronae at their IAU Gazetteer positions and sizes.
Their depth profiles come from published scaling laws. A few named landforms
come from published measurements:

- Herschel on Mimas (Moore et al. 2004)
- the Iapetus equatorial ridge (Giese et al. 2008)
- the Enceladus tiger stripes (Porco et al. 2006)

These areas are labelled "RECONSTRUCTED FEATURES" in the surface panel. They
are data-constrained reconstructions, not measured terrain.

**How the terrain is built.** Ground radius = reference shape + real elevation
+ microdetail. The real elevation is the finest of a whole-body grid (always
loaded), global 15° tiles streamed near the camera, and landmark windows at
the dataset's full resolution. Examples: HRSC–MOLA 200 m across Mars's
landmarks, the HiRISE DEM sampled at 25 m inside Gale, the CTX DTM at 20 m at
Jezero, and LOLA 118 m at Tycho and the Apollo sites. Microdetail is limited to wavelengths
under a quarter of the local cell (never above 24 m) with amplitude about
0.06 × wavelength, so it cannot make a hill or move a landform. Terrain
chunks, collision, landing and walking all use this one function, built in
Web Workers, which take jobs from a bounded priority queue and drop jobs that
are no longer needed. Rocks around you are procedural: they are placed in the
workers on a fixed lattice, are denser on steep ground, and differ by world.
Near the ground, the actual sun direction drives cascaded shadow maps for
terrain, rocks, buildings and the craft. Shadows are hard on airless worlds and
softer under Mars's, Venus's and Titan's atmospheres.

**Alignment.** Every source is read with its own central meridian and tie
point from its GeoTIFF GeoKeys. Twelve USGS products are centred on 180°.
`scripts/planetary/validate-alignment.mjs` checks map-to-DEM agreement and
writes `space/data/surfaces/alignment-report.txt`.

Earth's global grid is 10′. Region packs add 3DEP / Copernicus terrain, NAIP
imagery and OSM map data (see below). Around the launch site the pad and
apron are graded ground 3 m above sea level. The pad is an original design,
not a reconstruction of any NASA facility.

**Earth everywhere (global base layer).** Outside the five region packs,
Earth used to be its coarse global data and nothing else. Elevation is a 10′
grid (about 18.6 km per cell) and imagery a 20 km-per-pixel map, so from the
ground every place looked like the same flat green field.

A 22.5 MB global pack, loaded one 15° bundle at a time, now gives every place
on Earth:

- **Ground.** ESA WorldCover land cover at about 925 m colours and textures
  the ground (forest, fields, pavement, bare rock, snow) and draws coastlines,
  lakes and wide rivers.
- **Plants.** Vegetation is generated from that land cover.
- **Roads and rivers.** Natural Earth major roads and rivers, drawn in 3D.
- **Cities.** A procedural urban fallback of streets and blocks in built-up
  areas, labelled as procedural.

The region packs always take precedence inside their boxes. Over Earth,
landing waits until the local layers are ready, showing "LOADING LOCAL EARTH
DATA". F3 shows each layer's state.

**Real places worldwide (open data).** Besides the five original packs, Earth
has detailed packs built from **Overture Maps**:

- **Cities:** Paris, London, Tokyo, Dubai (Downtown, the Palm), Dhaka, Giza,
  Cairo, Rio, Sydney and Liberty Island.
- **Airports:** JFK, LAX, Heathrow, Haneda and Dubai International.
- **Ports:** Los Angeles, Rotterdam and Singapore.

**What's in each pack:**

- **Buildings:** OpenStreetMap, Microsoft ML and Google footprints,
  de-duplicated by Overture. Heights are measured where mapped, otherwise
  floors × 3 m or an estimate, and every building records which.
- **Roofs:** real roof shapes (gabled, hipped, pyramidal, dome…) where mapped.
- **Roads and rail:** real geometry, with bridges kept and tunnels left out.
- **Water:** rivers, lakes and sea.
- **Airports and ports:** runways, aprons, piers and docks.
- **Elevation:** Copernicus 30 m.
- **Imagery:**
  - Copernicus **Sentinel-2** (10 m, low-cloud scenes from 2023–2026) over
    about 16 km around each pack.
  - A finer national open orthophoto where one is redistributable: IGN
    (Paris), GSI (Tokyo, Haneda), PDOK (Rotterdam), and NAIP for the US packs.

Kilimanjaro, Fuji, Denali, Aconcagua, Mont Blanc, the Matterhorn and K2 get
30 m elevation packs, so their summits are real terrain. Around the
Matterhorn, swisstopo's swissALTI3D is blended in at ≈ 5 m, because 30 m data
cuts ~150 m off that sharp summit.

**Landmark registry.** 66 landmarks live in
`space/data/earth/landmarks.json`, each with coordinates from Wikidata
checked against OpenStreetMap. Disagreements are recorded, not averaged.
Selecting a landmark shows its **source accuracy**: where its location,
footprint and height come from, and that its facade is procedural, not
photogrammetry.

Reviewed corrections in `landmark-overrides.json` bind a landmark to its
exact open-data features, apply a published height with its source (Burj
Khalifa 829.8 m, Big Ben 96 m), or add an original **approximate model** from
published dimensions:

- the Sydney Opera House shells on the real outline
- the Harbour Bridge arch and the Brooklyn Bridge towers and cables, with the
  real roads lifted onto the decks
- the Tower Bridge walkways
- the Ahsan Manzil dome
- Christ the Redeemer

Each model is labelled approximate.

**Validation.** `scripts/earth/validate-world.mjs` checks this against
independent sources:

- **Airports:** runways against OurAirports (all 16 runways at the five
  airports match within 0.5°).
- **Peaks:** against published summits, allowing for DEM cell size and
  summit sharpness.
- **Rivers:** Wikidata bridges must stand on the drawn water, plus Natural
  Earth lines where they exist.
- **Landmarks:** footprints and heights.
- **Imagery:** alignment against vector water and runways, measured by
  `validate-imagery.py`.

Results are classed **PASS**, **WARN** (source resolution limit, source
disagreement, partial data) or **FAIL** (our implementation is wrong).
Currently there are 0 FAILs.

**Worldwide cells.** `scripts/earth/world-cells.json` turns any place on
Earth into a pack, built by the same pipeline (Overture, Copernicus GLO-30,
Sentinel-2, WorldCover). Twelve prototypes outside the original packs pass
validation:

- **Cities:** Berlin, Chattogram, São Paulo, Nairobi, Seoul, Mexico City and
  Auckland.
- **Rural:** Beauce farmland, Tefé on the Amazon, villages near Lilongwe and
  in Gopalganj, and farmland near Wagga Wagga.

Rural cells get only their real, sparse buildings: no procedural city blocks.

**Storage, measured on 36 packs and extrapolated:**

| Layer | Per km² |
| --- | --- |
| Vector tiles (buildings, roads, water, areas), dense city | 30–90 KB |
| Vector tiles, suburbs and towns | 15–35 KB |
| Vector tiles, rural | 1–17 KB |
| Per building, everything included | ≈ 20–70 bytes |
| Copernicus 30 m elevation | ≈ 1 KB |
| Sentinel-2 10 m imagery | ≈ 3.5 KB |
| Vegetation | ≈ 1 KB |

Extrapolated totals:

| Area | Approximate size |
| --- | --- |
| A 5 × 5 km city cell, everything included | 1.5–3 MB |
| Bangladesh | ≈ 1.5 GB |
| Germany | ≈ 4–5 GB |
| Brazil | ≈ 50 GB |
| USA | ≈ 60 GB (mostly imagery and elevation) |
| Europe | ≈ 60 GB |
| Africa | ≈ 150 GB |
| Asia | ≈ 250 GB |
| Whole world | ≈ 0.9–1 TB |
| Whole world, vector only (buildings and roads) | ≈ 100–150 GB |

These are extrapolations, not measurements of full builds.

**Free hosting:**

- GitHub Pages (public repository, GitHub Free) hosts the app and the
  packs. Its limits are a published site of up to 1 GB and a soft
  100 GB/month of bandwidth. The site is about 300 MB now.
- GitHub Release assets send no CORS header, so the browser can't read them;
  they aren't used.
- A full-detail world can't be hosted with zero paid services. Earth is
  therefore tiered: the global base layer everywhere (23 MB), plus detailed
  cells, about 2 MB each, chosen to stay inside the free 1 GB.
- A second public data repository on its own Pages site would add another
  free 1 GB. Pages serves `Access-Control-Allow-Origin: *`, so this works
  technically, but it shouldn't be multiplied to work around GitHub's limits.

**Outside the packs.** Everywhere else, Earth uses the global base layer
(land cover, major roads and rivers, labelled procedural city blocks).
Exact worldwide building streaming isn't possible on a static site without
hot-linking Overture's inspection-only tiles; see *Known limits*.

**Vegetation (Earth only).** Each region pack carries a vegetation pack
(`veg.bin`). No other world gets plants. Plants fall into two kinds:

- **Mapped** (OpenStreetMap): individual trees at their mapped positions,
  with their tagged height, crown and leaf type, plus tree rows, orchards and
  vineyards. Walk near a mapped tree and the panel shows what its tags say,
  and nothing more.
- **Generated**: placed from ESA WorldCover 2021 land cover and, in the US,
  NLCD 2021 tree-canopy density, on a deterministic blue-noise lattice. They
  are kept off buildings, roads, paths, rail, runways, water, parking and the
  pad, and thinned on steep ground. Snow, ice and bare rock get nothing.

There are eight 3D tree families: broadleaf, conifer, tall narrow conifer,
palm, mangrove, small ornamental, urban street tree and bushy small tree.
There are also shrubs, dry scrub, reeds, vine rows, crop rows and grass
clumps. These are broad visual categories, chosen per region and elevation
band, never species.

How far each layer draws (High preset):

- **Trees:** full 3D close by, simplified in the middle distance, and as
  low-poly crown clusters beyond 350 m, thinned with distance so a forest
  still reads as canopy, out to 4 km.
- **Shrubs:** to 160 m.
- **Grass:** to 45 m.
- **Shadows:** nearby trees cast them; their larger trunks block walking.
- **Wind:** a deterministic, visual-only sway.

The Low, Medium and Ultra presets scale distance, density, grass and shadows.
`scripts/earth/validate-vegetation.mjs` checks the result against the map
data.

### Architecture

There's no build step. The simulator is plain ES modules that the browser
loads on demand.

```
space/
  entry.js            helmet transition, loading sequence, return to portfolio
  main.js             simulator lifecycle: setup, frame loop, input map, teardown
  space.css           simulator UI (scoped under .sx-)
  engine/             coordinates, seeded RNG, JS + GLSL noise, time, input,
                      quality presets, worker pool
  universe/           catalogue loading, ephemerides, galaxy model, sector and
                      star-system generators, deep-sky structure, the Universe
                      orchestrator
  render/             renderer (far pass + lensing + near pass + bloom),
                      shaders, bodies, sky points, terrain, the craft
  nav/                flight and auto-travel, landing, the launch, walking,
                      targets, landmarks and search, picking
  craft/              the interceptor and its cockpit
  ui/                 HUD and panels, surface map, ambient and engine audio
  workers/            sector and galaxy-cloud generation off the main thread
  earth/              Earth region packs: map tiles, buildings and roads
                      (city-core.js), vegetation placement (veg-core.js, in the
                      workers), 3D plant models (veg-models.js), streaming and
                      drawing (vegetation.js)
  data/surfaces/      surface manifest and elevation grids (int16, gzipped)
scripts/astronomy/    catalogue build and validation scripts
scripts/planetary/    elevation, imagery and surface-manifest build scripts
scripts/earth/        Earth region packs: build-region.mjs (terrain, imagery,
                      OSM map tiles), build-vegetation.mjs (WorldCover, NLCD
                      canopy, OSM vegetation), validate-vegetation.mjs
data/astronomy/       processed catalogues (JSON) loaded by the simulator
```

Key decisions:

- **Coordinates.** A position is an integer sector index (sectors are 10¹³ m
  on a side) plus a float64 offset inside the sector. That keeps millimetre
  precision near the camera and still reaches across the observable universe.
  Each frame, everything is placed relative to the camera in float64 before
  being handed to the GPU as float32. In effect the origin is rebased every
  frame, so there's no jitter at any distance.
- **Two render passes.** The far pass works in light-years with no depth test
  and draws stars, galaxies, nebulae, belts and orbit lines as additive
  points. Brightness follows real apparent magnitude, with analytic dust
  extinction (the Milky Way's dark rift). The near pass works in metres with
  a logarithmic depth buffer and draws planets, atmospheres, rings and the
  craft. Distant near-pass objects are depth-compressed, keeping their exact
  direction and angular size, so float32 never overflows.
- **Level of detail.** Bodies progress from a point of reflected light, to a
  low-poly sphere, to full detail with atmosphere, clouds and rings, to
  quadtree terrain.
- **Surfaces.** One model per body (`space/universe/surfaces.js`) gives the
  ground radius in any direction: the reference shape (WGS 84 ellipsoid,
  triaxial ellipsoid for small moons, otherwise a sphere), plus the real
  elevation grid where there is one, plus microdetail. Terrain geometry,
  collision, landing, walking and the readouts all use it, so what you stand
  on is what you see. Terrain is a cube-sphere quadtree with skirts, built
  chunk-relative near the camera within a per-frame budget, and chunks
  wholly beyond the horizon aren't drawn. Elevation grids load only when you
  approach a body, and the browser decompresses them itself
  (`DecompressionStream`), so no server configuration is needed. Galaxies progress from a soft point of the right angular
  size, to a particle cloud drawn with a prefix of a shuffled buffer (so
  detail scales smoothly), to the full cloud.
- **Identity and level-of-detail handoff.** Every object has a stable id
  (`real:galaxy:M31`, `real:star:HIP70890`, `real:planet:Mars`,
  `procedural:star:mw:0:1333:0:-1:12`). Its point stand-in, its detailed
  representation and the search index all share one record. A representation
  is only retired once its successor is drawn: a galaxy's point stays lit
  until its cloud has faded fully in, a cloud is only replaced by a denser one
  that has arrived, and a planet keeps its point of light until its texture
  maps have loaded. Worker results carry a token, so a late reply for
  something already dropped is discarded.
- **Sector streaming.** Inside a galaxy, stars stream in from cells on three
  levels: 20 ly cells for dwarfs, 250 ly for A stars and giants, 1,500 ly for
  O/B stars and supergiants. Counts come from the galaxy's density field and
  the solar-neighbourhood luminosity function. Cells are generated in Web
  Workers from a hash of (galaxy, level, cell), so the same place always has
  the same stars. Cells load within radius r, both around the camera and a
  second ahead along its velocity, and unload only beyond r + 1 (hysteresis).
  Starting a trip with `G` preloads the destination and pins it until arrival. Around the Sun, generated stars that the real catalogues
  already cover are left out.
- **Performance.**
  - Quality presets (Low/Medium/High/Ultra) are auto-detected from the device
    and adjustable in settings.
  - Quality steps down automatically if frame times stay high.
  - Workers handle generation; terrain is built within a per-frame budget.
  - GPU resources are disposed when out of range, and everything is released
    on exit.
  - The portfolio's own hero render loop pauses while the simulator covers it.
- **Loading.** Normal visitors download nothing extra. `space/entry.js` is
  fetched only on the helmet click. After that come the simulator, the
  catalogues, Earth's global grid and maps, and the Kennedy region pack's
  terrain, imagery and map tiles for the launch: about 18 MB measured without
  compression (GitHub Pages gzips the JSON and JavaScript, so less in
  practice). Other packs load on approach (NYC about 11 MB, Grand Canyon 5.6,
  Rainier 5.4, Everest 1.1), as do other bodies' elevation (Moon about 1.8 MB
  with its patches, Mars about 7 MB with its patches and map). No runtime
  request leaves the site except three.js from jsDelivr and the page's fonts.
  three.js comes from the same importmap the page already uses.

### Updating the catalogues

The scripts need Node 18+ and network access. Raw catalogues are never
committed, only the processed subsets.

```bash
node scripts/astronomy/fetch-exoplanets.mjs     # NASA Exoplanet Archive (TAP)
node scripts/astronomy/build-star-catalog.mjs   # HYG v4.1 + Gaia DR3 (parallax > 50 mas)
node scripts/astronomy/build-galaxy-catalog.mjs # UNGC (VizieR) + NED landmarks + HyperLEDA background layer
node scripts/astronomy/build-deep-sky.mjs       # curated nebulae, clusters, black holes, neutron stars
node scripts/astronomy/build-solar-system.mjs   # JPL elements, IAU rotation, physical data
node scripts/astronomy/validate-catalogs.mjs    # sanity checks before shipping
node scripts/planetary/fetch-elevation.mjs      # ETOPO 2022 (+ the Cape patch), LOLA, MOLA → space/data/surfaces/
node scripts/planetary/fetch-imagery.mjs        # Blue Marble, Black Marble, Venus radar map → textures/
node scripts/planetary/build-terrain.mjs all      # global tiles, landmark windows and USGS mosaics (range requests)
node scripts/planetary/build-surface-manifest.mjs  # gravity, atmosphere, terrain labels and data class per body
node scripts/planetary/validate-alignment.mjs    # map vs DEM alignment report
node scripts/earth/build-region.mjs all         # Earth region packs (needs libjpeg-turbo's djpeg/cjpeg for Everest; ~2.4 GB of OSM extracts cached in the OS temp folder)
```

### Running and deploying

- **Locally:** `python3 -m http.server 8000` from the repo root, then open
  `http://localhost:8000`. Use a server rather than `file://`, because
  modules and workers need HTTP. Add `?sxdebug` to the URL to expose a test
  handle (`window.__sx`).
- **iCloud Drive:** if the repo sits in an iCloud-synced folder with
  "Optimize Mac Storage" on, macOS may evict data files to placeholders. Each
  read then stalls for about a second, so builds crawl and local loads look
  slow. Download the folder ("Keep Downloaded") before building or profiling.
- **GitHub Pages:** serves the repo root as-is. Every simulator URL is
  resolved relative to its module (`import.meta.url`), so it works under any
  base path. When you deploy, bump the build stamp in both `version.json` and
  `index.html`, so open tabs pick up the new version.

### Data sources

- **Stars:** [HYG Database v4.1](https://github.com/astronexus/HYG-Database)
  (CC BY-SA 4.0) and [ESA Gaia DR3](https://www.cosmos.esa.int/gaia)
  (ESA/Gaia/DPAC, CC BY-SA 3.0 IGO).
- **Exoplanets:** [NASA Exoplanet Archive](https://exoplanetarchive.ipac.caltech.edu/),
  Planetary Systems Composite Parameters.
- **Galaxies:** [Updated Nearby Galaxy Catalog](https://vizier.cds.unistra.fr/viz-bin/VizieR?-source=J/AJ/145/101)
  (Karachentsev, Makarov & Kaisina 2013), with landmark distances from
  [NED](https://ned.ipac.caltech.edu/).
- **Nebulae, clusters, black holes and pulsars:** positions from
  [SIMBAD](https://simbad.cds.unistra.fr/), the
  [ATNF Pulsar Catalogue](https://www.atnf.csiro.au/research/pulsar/psrcat/),
  and literature distances cited per object in `build-deep-sky.mjs`.
- **Solar System:** [JPL Solar System Dynamics](https://ssd.jpl.nasa.gov/)
  (planetary and satellite elements, Small-Body Database) and the IAU WGCCRE
  2015 rotation report.
- **Background galaxies:** [HyperLEDA](http://atlas.obs-hp.fr/hyperleda/)
  (Makarov et al. 2014).
- **Imagery:** maps in `textures/` from [Solar System Scope](https://www.solarsystemscope.com/textures/),
  based on NASA mission imagery, licensed [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/);
  Earth from NASA [Blue Marble](https://svs.gsfc.nasa.gov/2915) and
  [Black Marble 2016](https://earthobservatory.nasa.gov/features/NightLights) (public domain).
- **Elevation:** [NOAA NCEI ETOPO 2022](https://www.ncei.noaa.gov/products/etopo-global-relief-model),
  [LRO LOLA LDEM_4](https://pds-geosciences.wustl.edu/missions/lro/lola.htm) and
  [MGS MOLA MEGDR](https://pds-geosciences.wustl.edu/missions/mgs/megdr.html) (all public domain).
- **Landmarks:** the [IAU Gazetteer of Planetary Nomenclature](https://planetarynames.wr.usgs.gov/)
  and USGS GNIS.
- **Earth vegetation:** [ESA WorldCover 10 m 2021 v200](https://esa-worldcover.org/)
  (CC BY 4.0, © ESA WorldCover project 2021 / Contains modified Copernicus
  Sentinel data (2021) processed by ESA WorldCover consortium),
  [NLCD 2021 Tree Canopy Cover](https://www.mrlc.gov/) (USDA Forest Service,
  public domain) and OpenStreetMap trees and vegetation areas (ODbL).

Licences, attributions and processing steps for every file are in
[CREDITS.md](CREDITS.md).

The simulator's own Credits panel lists the same sources.

### Known limits (not built yet)

- **Surface resolution.** Outside the five region packs, Earth's elevation is
  10′ and its imagery about 20 km per pixel, and there are no buildings.
  The Moon and Mars grids are 4 px/° outside their detail patches. Nothing is
  streamed from a tile service, since that would need an API key or a backend.
- **Building heights.** In NYC 73% of buildings carry a real height tag. At
  Kennedy almost none do (Florida's OSM footprints are mostly height-less), so
  heights there are estimates; see `CREDITS.md`.
- **Real relief elsewhere.** No global DEM is published for Io, Europa,
  Ganymede, Callisto, Titan, the mid-size Saturnian moons, Triton or the
  Uranian moons; only regional stereo or radar strips exist. Their relief
  between the reconstructed features is procedural, held to typical values
  and labelled. Their imagery is real, except for the Uranian moons, which
  have no global mosaic.
- **Vesta coordinates.** The IAU Gazetteer and the DLR DTM both use the
  "Claudia double-prime" system. This was verified: all 42 Gazetteer craters
  tested are depressions at 0° offset. Map-to-DEM correlation for Vesta,
  Phobos and Enceladus is weak (their maps share little detail with their
  heights), so `validate-alignment.mjs` reports it as inconclusive or flagged.
  Their georeferencing is read from the files themselves.
- **Shape models.** Phobos and Enceladus use real global shape grids (HRSC,
  Cassini), and Deimos and Hyperion use Thomas 5° radius grids. Mimas, Tethys,
  Dione, Rhea, Iapetus and Haumea are published ellipsoids. The remaining
  small bodies are catalogue ellipsoids.
- **Shadows.** The cockpit interior doesn't receive the local shadow maps,
  and Earth has no rocks.
- **Exact buildings everywhere.** Exact footprints ship only for the packs,
  25 new ones at about 18 MB in all. Streaming all 2.5 billion Overture
  buildings at runtime would mean hot-linking Overture's PMTiles, which
  Overture marks "for data inspection only, not production". GHSL building
  height (CC BY 4.0) would give real urban massing worldwide, but it's only
  published as 4.6–7.9 GB global files and wasn't processed. Landmarks are
  their real footprints and heights with procedural facades. Six have
  original approximate models; none is a detailed or photogrammetric model.
- **Everything here is free.** `space/data/licenses.json` lists every
  resource, and `node scripts/validate-free-resources.mjs` fails the build on
  anything paid, trial-based, billing-required or of unknown licence. The
  runtime uses only the site's own files plus NASA's free NeoWs feed.
- **Steep terrain on Low/Medium quality.** Those presets build terrain
  meshes with ~100 m+ vertex spacing, so on very steep relief (Corcovado,
  hillside favelas) the drawn ground sits below the real height that
  buildings, trees and the walker use, and objects appear to float. High and
  Ultra (~10 m) are correct.
- **Imagery resolution.**
  - London, Sydney, Dubai, Dhaka, Cairo, Rio and Singapore have only 10 m
    Sentinel-2: streets read as texture, not detail. No open orthophoto is
    redistributable there (NSW's licence is published inconsistently).
  - Imagery is a flat drape, so tall buildings and towers also appear
    "painted" on the ground under their 3D models.
  - GSI's Tokyo mosaic shows sun-glint stripes over the water.
  - The fine orthophotos are colour-matched to the 10 m Sentinel-2 scene,
    so they take on that scene's season.
- **Earth outside the region packs.**
  - Elevation stays the 10′ global grid, so hills and valleys smaller than
    about 20 km are missing.
  - Land cover is at about 925 m, so narrow rivers, small parks and streets
    are only shown where Natural Earth has them.
  - Buildings there are procedural, never real.
- **Vegetation.** In the packs it follows mapped trees and canopy data;
  outside them it follows land-cover class only. Land cover is a single 2021 snapshot with no
  seasons. Most OSM trees carry no species or size, so most mapped trees use
  a size estimated for their category. Generated plants are statistical, not
  surveyed.
- **Map key.** The surface map is on `T`, because `M` (mouse-look) and `N`
  (time: now) were already taken.
- **Multiple stars.** Procedural systems have at most one companion star;
  triples and higher aren't generated.
- **Nebula rendering.** Nebulae are layered particles, not ray-marched
  volumes.
- **Collisions.** There's no collision with anything except the ground you're
  flying over (and the launch pad's deck).
- **Saving.** Only settings and discovered systems are saved, and only in your
  browser. There are no saved locations or favourites.

## Credits

- Planet, Moon, Sun and Saturn ring maps in `textures/` are from [Solar System Scope](https://www.solarsystemscope.com/textures/), based on NASA mission imagery, licensed [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). Earth imagery is NASA's (public domain).
- Full licence and attribution details: [CREDITS.md](CREDITS.md).
- Astronomical data sources are listed under *Data sources* above.
