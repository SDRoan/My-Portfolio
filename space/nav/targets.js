// Targets: anything you can select, inspect and travel to. Each knows where it
// is right now, how close is a sensible place to stop, and what is actually
// known about it — catalogue values are shown as catalogued, derived values
// are marked estimated, and generated objects are labelled procedural.

import { UPos, LY, AU, KM, R_SUN, sub, fmtDistance, fmtNum } from "../engine/coords.js";
import { describeMorphology, galaxyParams } from "../universe/galaxymodel.js";
import { typeLabel } from "../universe/systemgen.js";
import { spectralType, describeClass, habitableZone } from "../universe/stellar.js";
import { compactRadius, distUP, starKey } from "../universe/universe.js";
import { hashString } from "../engine/rng.js";
import * as THREE from "three";
import { dirFromLatLon, fmtLatLon } from "../universe/surfaces.js";

const U = "Unknown";
const n = (v, unit, d = 3) => (v === null || v === undefined || Number.isNaN(v) ? U : fmtNum(v, d) + (unit ? " " + unit : ""));
const est = (s) => s + " (est.)";

export class Targets {
  constructor(universe) { this.u = universe; }

  // Solar System body by id.
  solar(id) {
    const s = this.u.solar.get(id);
    if (!s) return null;
    const b = s.data, body = s.body;
    const R = s.def.radius;
    const kindLabel = { star: "Star", planet: "Planet", dwarf: "Dwarf planet", moon: "Moon", asteroid: "Asteroid", comet: "Comet" }[b.kind];
    return {
      id: "real:" + b.kind + ":" + b.name, name: b.name, kind: b.kind, real: true, body,
      cls: b.kind === "star" ? "G2V main-sequence star" : kindLabel + (b.parent && b.parent !== "sun" ? " of " + this.u.solar.get(b.parent).data.name : ""),
      pos: () => s.def.pos, radius: R,
      stop: b.kind === "star" ? R * 14 : R * (b.atmosphere ? 3.2 : 2.6) + (b.rings ? R * 2.6 : 0),
      info: () => {
        const rows = [["Type", kindLabel]];
        if (b.kind === "star") {
          rows.push(["Spectral class", "G2V"], ["Radius", "695,700 km"], ["Mass", "1.989 × 10³⁰ kg"], ["Temperature", "5,772 K"], ["Luminosity", "3.828 × 10²⁶ W"]);
        } else {
          rows.push(["Radius", n(b.radiusKm, "km", 5)], ["Mass", n(b.massKg, "kg")],
            ["Gravity", n(6.674e-11 * b.massKg / Math.pow(b.radiusKm * 1000, 2), "m/s²")]);
          if (b.elements) rows.push(["Orbit (a)", n(b.elements[0], "AU", 4)], ["Eccentricity", n(b.elements[1], "", 3)], ["Period", n(365.25 * Math.pow(b.elements[0], 1.5) / 365.25, "yr", 4)]);
          if (b.osculating) rows.push(["Orbit (a)", n(b.osculating[0], "AU", 4)], ["Eccentricity", n(b.osculating[1])]);
          if (b.perihelion) rows.push(["Perihelion", n(b.perihelion[0], "AU", 3)], ["Eccentricity", n(b.perihelion[1], "", 4)], ["Period", n(Math.pow(b.perihelion[0] / (1 - b.perihelion[1]), 1.5), "yr", 3)]);
          if (b.moon) rows.push(["Orbit (a)", n(b.moon[0], "km", 6)], ["Period", n(Math.abs(b.moon[1]), "days", 4)]);
          if (b.spin) rows.push(["Rotation", n(Math.abs(360 / b.spin[5]) * 24, "h", 4) + (b.spin[5] < 0 ? " (retrograde)" : "")]);
          rows.push(["Atmosphere", b.atmosphere ? b.atmosphere.note : "None / negligible"]);
          if (b.rings) rows.push(["Rings", "Yes"]);
          const moons = [...this.u.solar.values()].filter((m) => m.data.parent === id).map((m) => m.data.name);
          if (moons.length) rows.push(["Moons (modelled)", moons.join(", ")]);
        }
        if (b.kind !== "star") rows.push(["Distance from Sun", fmtDistance(distUP(s.def.pos, this.u.sun.def.pos))]);
        const notes = ["Data: JPL Solar System Dynamics, IAU rotation elements"];
        if (typeof b.look === "string" && b.look.startsWith("map:") || b.look === "earth") notes.push("Surface: global map from NASA mission imagery (Solar System Scope, CC BY 4.0)");
        else notes.push("Surface visualization: procedural interpretation");
        if (b.moon && !b.lunarTheory) notes.push("Position along its orbit is approximate (mean orbit, assumed phase)");
        if (b.osculating) notes.push("Position from osculating elements — approximate");
        return { rows, notes };
      }
    };
  }

  // A named place on a Solar System body. Its position turns with the body;
  // the craft is routed around the limb (a waypoint ≤ 30° of arc ahead, at
  // ≥ 1.5 R) so a site on the far side is never approached through the body,
  // and the trip ends 2 km above the ground.
  landmark(L) {
    const s = this.u.solar.get(L.body);
    if (!s) return null;
    const body = s.body, R = s.def.radius;
    const local = new THREE.Vector3(...dirFromLatLon(L.lat, L.lon));
    const site = (h) => {
      const u = local.clone().applyQuaternion(body.quat);
      const r = body.getSurface().radiusAt(local.x, local.y, local.z, 5) + h;
      return { u, p: body.pos.clone().add(u.x * r, u.y * r, u.z * r) };
    };
    return {
      id: "landmark:" + L.body + ":" + L.name, name: L.name, kind: "landmark", real: true, body, lat: L.lat, lon: L.lon,
      cls: L.kind + " · " + s.data.name, radius: 0, stop: 0,
      pos: () => site(2000).p,
      // Where auto-travel steers: the site, or a waypoint around the limb.
      travelPos: () => {
        const { u, p } = site(2000);
        const from = this.from ? this.from() : null;
        if (!from) return p;
        const v = new THREE.Vector3(...sub(from, body.pos));
        const dist = v.length(), uc = v.normalize();
        const ang = uc.angleTo(u);
        if (ang < 0.52) return p;                             // within 30°: straight in
        // Rotate 30° from the craft's direction toward the site, high above.
        const axis = new THREE.Vector3().crossVectors(uc, u);
        if (axis.lengthSq() < 1e-12) axis.set(0, 1, 0).applyQuaternion(body.quat);
        const w = uc.clone().applyAxisAngle(axis.normalize(), 0.52);
        const r = Math.max(dist, R * 1.5);
        return body.pos.clone().add(w.x * r, w.y * r, w.z * r);
      },
      info: () => {
        const h = body.getSurface().heightAt(local.x, local.y, local.z, 5);
        const rows = [["Type", L.kind], ["On", s.data.name], ["Coordinates", fmtLatLon(L.lat, L.lon)], ["Elevation (model)", (h < 0 ? "−" : "") + fmtDistance(Math.abs(h))]];
        const notes = ["Coordinates: " + L.src, "Arrives 2 km above the site · L to land"];
        const R = L.registry;
        if (R) {
          // Source accuracy: what is real here and where it comes from.
          rows.push(["Source accuracy", R.accuracy]);
          rows.push(["Location", "Wikidata" + (R.osm ? " · OpenStreetMap " + R.distanceM + " m apart (" + R.confidence + ")" : " only")]);
          const F = R.footprint;
          if (F) rows.push(["Footprint", F.dataset + " · " + F.lengthM + " × " + F.widthM + " m (detailed pack " + R.pack + "; matched: " + F.match + ")"]);
          const A = R.authoritativeHeight;
          if (A) rows.push(["Height", A.valueM + " m — published (" + A.measurement + "; " + A.source + ", confidence " + A.confidence + ")" + (F && F.heightM != null ? " · drawn " + F.heightM + " m" : "")]);
          else if (R.published && R.published.statueM) rows.push(["Height", "≈" + R.published.statueM + " m statue · ≈" + R.published.totalM + " m including the " + R.published.pedestalM + " m pedestal · arms " + R.published.armSpanM + " m (published)"]);
          else if (R.heightM) rows.push(["Height", R.heightM + " m — published (Wikidata)" + (F && F.heightM != null ? " · drawn " + F.heightM + " m (" + F.heightSource + ")" : "")]);
          else if (F && F.heightM != null) rows.push(["Height", F.heightM + " m — " + F.heightSource]);
          if (R.elevationM !== null && R.elevationM !== undefined) rows.push(["Elevation (published)", R.elevationM + " m (Wikidata)"]);
          rows.push(["Visual model", R.model ? "Approximate model from published dimensions (original, not photogrammetry)" : R.footprint ? "Real footprint, procedural facade — not photogrammetry" : R.pack ? "Open-data surroundings; no model of the landmark itself" : "Marker only; global base surroundings"]);
          if (R.modelNote) notes.push("Model: " + R.modelNote);
          if (R.orientation) notes.push("Facing " + Math.round(R.orientation.facingDeg) + "° (confidence " + R.orientation.confidence + "): " + R.orientation.basis);
          if (R.partial) notes.push("Partial data: " + R.partial);
          if (R.sourceDisagreement) notes.push("Source disagreement: " + R.sourceDisagreement);
          if (R.discrepancy) notes.push("Discrepancy: " + R.discrepancy);
          if (R.heightNote) notes.push(R.heightNote);
        }
        return { rows, notes };
      }
    };
  }

  // Catalogue star.
  star(s) {
    const R = (s.radiusSun || 1) * R_SUN;
    const host = s.exoHost;
    return {
      id: starKey(s), name: s.name || s.desig, kind: "star", real: true, rec: s,
      cls: (s.spect ? s.spect.split(/[ +]/)[0] + " " : "") + (describeClass(s.lumClass) || "star"),
      pos: () => s.upos, radius: R, stop: Math.max(R * 14, 0.02 * AU),
      info: () => {
        const rows = [
          ["Designation", s.desig], ["Spectral type", s.spect || U],
          ["Distance from Sol", fmtDistance(s.distLy * LY)],
          ["Absolute magnitude (V)", n(s.absMag, "", 3)],
          ["Temperature", s.teffSrc ? est(n(Math.round(s.teff), "K", 5)) + " from " + s.teffSrc : U],
          ["Luminosity", s.lumSun ? est(n(s.lumSun, "L☉")) : U],
          ["Radius", s.radiusSun ? est(n(s.radiusSun, "R☉")) : U],
          ["Mass", s.massSun ? est(n(s.massSun, "M☉")) : U],
          ["Catalogue", s.src + (s.gaia ? " · Gaia DR3 " + s.gaia : "") + (s.hip ? " · HIP " + s.hip : "")]
        ];
        if (host) rows.push(["Confirmed planets", String(host.planetList.length)]);
        else rows.push(["Confirmed planets", "None listed in the NASA Exoplanet Archive"]);
        const notes = ["Position and brightness from the catalogue; temperature, radius and mass are estimated from colour and luminosity"];
        if (host) notes.push("Planets drawn from NASA Exoplanet Archive values; their surfaces are procedural interpretations");
        return { rows, notes };
      }
    };
  }

  // Procedural star from a sector.
  procStar(rec) {
    const sys = this.u.systems.get(rec.key);
    const props = rec.props || (sys && sys.star);
    const R = (props ? props.radiusSun : 1) * R_SUN;
    const disc = this.u.discovered.get(rec.key);
    return {
      id: rec.key, name: (disc && disc.customName) || rec.name, kind: "star", real: false, rec,
      cls: props ? props.description : "Star", pos: () => rec.upos, radius: R, stop: Math.max(R * 14, 0.02 * AU),
      renamable: true,
      info: () => {
        const sy = this.u.systems.get(rec.key);
        const p = rec.props || (sy && sy.star);
        const rows = [["Designation", rec.name + (disc && disc.customName ? " · named “" + disc.customName + "” (yours, unofficial)" : "")]];
        if (p) rows.push(["Type", p.description], ["Spectral type", p.spectType], ["Temperature", n(Math.round(p.teff), "K", 5)],
          ["Luminosity", n(p.lumSun, "L☉")], ["Radius", n(p.radiusSun, "R☉")], ["Mass", n(p.massSun, "M☉")], ["Age", n(p.ageGyr, "Gyr", 2)]);
        else rows.push(["Temperature", n(Math.round(rec.teff), "K", 5)], ["Absolute magnitude", n(rec.absMag)]);
        rows.push(["Galaxy", rec.galaxy.rec.common || rec.galaxy.rec.name]);
        if (rec.galaxy.isMW) rows.push(["Distance from Sol", fmtDistance(distUP(rec.upos, new UPos()))]);
        if (sy && sy.content) {
          rows.push(["Planets", String(sy.content.planets.length)]);
          if (sy.companion) rows.push(["Companion", sy.companion.def.name]);
        } else rows.push(["Planets", "Approach to survey"]);
        return { rows, notes: ["Generated for simulation from a deterministic seed — not a catalogued star"] };
      }
    };
  }

  // A body in an active non-solar system (procedural or real exoplanet).
  sysBody(b) {
    const p = b.planet, m = b.moon;
    const real = !!(p && p.real);
    const R = b.radius;
    const sys = b.system;
    return {
      id: b.def.id, name: b.def.name, kind: b.def.kind, real, body: b,
      cls: p ? typeLabel(p.type) + (real ? " · confirmed exoplanet" : "") : m ? typeLabel(m.type) + " moon" : b.def.kind === "star" ? "Companion star" : b.def.kind,
      pos: () => b.pos, radius: R, stop: R * (b.def.atmosphere ? 3.2 : 2.6) + (b.def.rings ? R * 2.4 : 0),
      info: () => {
        const rows = [];
        if (real) {
          const c = p.catalog;
          rows.push(["Host", sys.star.name], ["Discovery", (c.year || U) + (c.method ? " · " + c.method : "")],
            ["Radius", c.radEarth !== null ? n(c.radEarth, "R⊕") : U], ["Mass", c.massEarth !== null ? n(c.massEarth, "M⊕") + (c.massIsMin ? " (minimum, M·sin i)" : "") : U],
            ["Orbital period", c.periodDays !== null ? n(c.periodDays, "days", 5) : U], ["Semi-major axis", c.aAU !== null ? n(c.aAU, "AU", 4) : U],
            ["Eccentricity", c.ecc !== null ? n(c.ecc) : U], ["Equilibrium temp.", c.teqK !== null ? n(c.teqK, "K") : U],
            ["Distance from Sol", sys.rec.distLy ? fmtDistance(sys.rec.distLy * LY) : U]);
          const notes = ["Catalogue parameters from the NASA Exoplanet Archive", "Surface visualization: procedural interpretation (" + typeLabel(p.type).toLowerCase() + ")"];
          if (p.visual.radiusEstimated) notes.push("Drawn size estimated from mass — radius not measured");
          if (p.visual.aEstimated) notes.push("Orbit size estimated from the period");
          notes.push("Orbit orientation and position along the orbit are assumed");
          return { rows, notes };
        }
        if (p) {
          rows.push(["Host", sys.star.name], ["Type", typeLabel(p.type)], ["Radius", n(p.radiusKm, "km", 4)], ["Mass", n(p.massEarth, "M⊕")],
            ["Gravity", n(p.gravityG, "g")], ["Orbital period", n(p.periodDays, "days", 4)], ["Orbit (a)", n(p.aAU, "AU", 3)],
            ["Temperature", n(p.teqK, "K") + (p.inHZ ? " · in habitable zone" : "")], ["Atmosphere", p.atmosphere ? p.atmosphere.kind : "None"],
            ["Day length", p.tidallyLocked ? "Tidally locked" : n(p.dayHours, "h")], ["Axial tilt", n(p.tiltDeg, "°", 2)],
            ["Moons", String((p.moons || []).length)], ["Rings", p.rings ? "Yes" : "No"]);
        } else if (m) {
          rows.push(["Orbits", b.parentBody.def.name], ["Type", typeLabel(m.type)], ["Radius", n(m.radiusKm, "km", 4)], ["Orbit (a)", n(m.aKm, "km", 4)],
            ["Period", n(m.periodDays, "days", 3)], ["Temperature", n(m.teqK, "K")], ["Atmosphere", m.atmosphere ? m.atmosphere.kind : "None"]);
        } else {
          const c = b.orbit;
          rows.push(["Type", c.description], ["Spectral type", c.spectType], ["Temperature", n(Math.round(c.teff), "K", 5)], ["Mass", n(c.massSun, "M☉")], ["Separation", n(c.aAU, "AU")]);
        }
        return { rows, notes: ["Procedural object — generated for simulation"] };
      }
    };
  }

  galaxy(e) {
    const g = e.rec;
    const R = (g.diamKly || 20) * 500 * LY;
    return {
      id: g.id || "real:galaxy:" + g.name, name: g.common && g.common !== g.name && !g.common.includes(g.name) ? g.common + " (" + g.name + ")" : g.common || g.name,
      kind: "galaxy", real: !g.procedural, entry: e,
      cls: describeMorphology(g.type || (e.params || galaxyParams(g)).type, g.ttype, g.barred).replace(/ galaxy$/i, "") + " galaxy",
      pos: () => e.center, radius: R, stop: e.isMW ? R * 1.4 : R * 1.6,
      info: () => {
        const rows = [
          ["Morphology", describeMorphology(g.type || e.params.type, g.ttype, g.barred) + (g.dwarfClass ? " · " + g.dwarfClass : "")],
          ["Distance from Sol", e.isMW ? "26,670 ly to its centre" : fmtDistance((g.distLy || distUP(e.center, new UPos()) / LY) * LY)],
          ["Diameter", n(g.diamKly, "kly") + (g.diamEstimated ? " (estimated)" : "")]
        ];
        if (g.absBmag !== null && g.absBmag !== undefined) rows.push(["Absolute B magnitude", n(g.absBmag) + (g.procedural ? " (simulated)" : "")]);
        if (g.logMass) rows.push(["Mass (within Holmberg radius)", "10^" + g.logMass + " M☉"]);
        rows.push(["Stellar population", e.isMW ? "~100–400 billion (literature estimate)" : g.procedural ? "~" + fmtNum(g.lumSun * 1.5, 2) + " (simulated)" : "~" + fmtNum(g.lumSun * 1.5, 2) + " (rough estimate from luminosity)"]);
        rows.push(["Group / cluster", g.group || U]);
        if (g.inclDeg !== null && g.inclDeg !== undefined) rows.push(["Inclination", n(g.inclDeg, "°")]);
        const notes = [];
        if (g.procedural) notes.push("Procedural galaxy — generated for simulation");
        else if (e.isMW) notes.push("Structure modelled on published arm, bar and solar-position measurements; individual stars beyond the catalogues are procedural");
        else notes.push("Position, distance, size and type: " + (g.src === "UNGC" ? "Updated Nearby Galaxy Catalog (Karachentsev+ 2013)" : g.src),
          "3D structure: procedural visualization of its morphology; orientation from catalogue inclination, position angle approximate");
        return { rows, notes };
      }
    };
  }

  group(gr) {
    return {
      id: "real:group:" + gr.name, name: gr.name, kind: "group", real: true, cls: /Cluster/.test(gr.name) ? "Galaxy cluster" : "Galaxy group",
      pos: () => gr.upos, radius: gr.radiusLy * LY, stop: gr.radiusLy * LY * 1.8,
      info: () => ({
        rows: [["Catalogued members", String(gr.members.length)], ["Extent of members", fmtDistance(gr.radiusLy * 2 * LY)],
          ["Distance from Sol", fmtDistance(distUP(gr.upos, new UPos()))], ["Brightest members", gr.members.slice().sort((a, b) => (b.lumSun || 0) - (a.lumSun || 0)).slice(0, 4).map((m) => m.common || m.name).join(", ")]],
        notes: ["Membership and centre from the galaxy catalogue's group assignments"]
      })
    };
  }

  deep(o) {
    const kindLabel = { nebula: { emission: "Emission nebula", reflection: "Reflection nebula", dark: "Dark nebula", planetary: "Planetary nebula", snr: "Supernova remnant" }[o.subtype],
      cluster: o.subtype === "globular" ? "Globular cluster" : "Open cluster",
      blackhole: o.subtype === "supermassive" ? "Supermassive black hole" : "Stellar-mass black hole",
      neutronstar: { pulsar: "Pulsar (neutron star)", magnetar: "Magnetar (neutron star)", isolated: "Isolated neutron star" }[o.subtype] }[o.kind];
    const compact = o.kind === "blackhole" || o.kind === "neutronstar";
    const R = compact ? compactRadius(o) : Math.max(0.1, o.sizeLy / 2) * LY;
    return {
      id: "real:" + o.kind + ":" + o.name, name: o.name, kind: o.kind, real: true, rec: o, cls: kindLabel,
      get body() { return o.body || null; },
      pos: () => o.upos, radius: R, stop: compact ? (o.kind === "blackhole" ? R * 40 : 2.5e7) : R * (o.kind === "cluster" ? 2.2 : 2.6),
      info: () => {
        const rows = [["Type", kindLabel]];
        if (o.aliases && o.aliases.length) rows.push(["Also known as", o.aliases.join(", ")]);
        rows.push(["Distance from Sol", fmtDistance((o.distLy || distUP(o.upos, new UPos()) / LY) * LY)]);
        if (!compact) rows.push(["Size", n(o.sizeLy, "ly")]);
        if (o.extra.massSun) rows.push(["Mass", n(o.extra.massSun, "M☉")], ["Schwarzschild radius", fmtDistance(R / 2.6)]);
        if (o.extra.companion) rows.push(["Companion", o.extra.companion]);
        if (o.extra.periodS) rows.push(["Spin period", o.extra.periodS < 1 ? n(o.extra.periodS * 1000, "ms") : n(o.extra.periodS, "s")]);
        if (o.extra.members) rows.push(["Members", "~" + fmtNum(o.extra.members, 2)]);
        if (o.extra.ageMyr) rows.push(["Age", n(o.extra.ageMyr, "Myr")]);
        if (o.hostGalaxy) rows.push(["Host galaxy", o.hostGalaxy]);
        rows.push(["Reference", o.ref]);
        const notes = [];
        if (o.kind === "nebula" || o.kind === "cluster") notes.push("Position, distance and size: catalogue/literature. Internal structure: procedural visualization");
        if (o.kind === "blackhole") notes.push("Accretion disc, Doppler brightening and lensing are visual approximations, not a relativistic simulation");
        if (o.kind === "neutronstar" && o.extra.periodS) notes.push("Beam sweep is slowed for display; the true spin period is listed above");
        return { rows, notes };
      }
    };
  }
}

// ── search ──
const GREEK = { Alp: "Alpha", Bet: "Beta", Gam: "Gamma", Del: "Delta", Eps: "Epsilon", Zet: "Zeta", Eta: "Eta", The: "Theta", Iot: "Iota",
  Kap: "Kappa", Lam: "Lambda", Mu: "Mu", Nu: "Nu", Xi: "Xi", Omi: "Omicron", Pi: "Pi", Rho: "Rho", Sig: "Sigma", Tau: "Tau", Ups: "Upsilon",
  Phi: "Phi", Chi: "Chi", Psi: "Psi", Ome: "Omega" };
const CON = { And: "Andromedae", Ant: "Antliae", Aps: "Apodis", Aqr: "Aquarii", Aql: "Aquilae", Ara: "Arae", Ari: "Arietis", Aur: "Aurigae",
  Boo: "Bootis", Cae: "Caeli", Cam: "Camelopardalis", Cnc: "Cancri", CVn: "Canum Venaticorum", CMa: "Canis Majoris", CMi: "Canis Minoris",
  Cap: "Capricorni", Car: "Carinae", Cas: "Cassiopeiae", Cen: "Centauri", Cep: "Cephei", Cet: "Ceti", Cha: "Chamaeleontis", Cir: "Circini",
  Col: "Columbae", Com: "Comae Berenices", CrA: "Coronae Australis", CrB: "Coronae Borealis", Crv: "Corvi", Crt: "Crateris", Cru: "Crucis",
  Cyg: "Cygni", Del: "Delphini", Dor: "Doradus", Dra: "Draconis", Equ: "Equulei", Eri: "Eridani", For: "Fornacis", Gem: "Geminorum",
  Gru: "Gruis", Her: "Herculis", Hor: "Horologii", Hya: "Hydrae", Hyi: "Hydri", Ind: "Indi", Lac: "Lacertae", Leo: "Leonis", LMi: "Leonis Minoris",
  Lep: "Leporis", Lib: "Librae", Lup: "Lupi", Lyn: "Lyncis", Lyr: "Lyrae", Men: "Mensae", Mic: "Microscopii", Mon: "Monocerotis", Mus: "Muscae",
  Nor: "Normae", Oct: "Octantis", Oph: "Ophiuchi", Ori: "Orionis", Pav: "Pavonis", Peg: "Pegasi", Per: "Persei", Phe: "Phoenicis", Pic: "Pictoris",
  Psc: "Piscium", PsA: "Piscis Austrini", Pup: "Puppis", Pyx: "Pyxidis", Ret: "Reticuli", Sge: "Sagittae", Sgr: "Sagittarii", Sco: "Scorpii",
  Scl: "Sculptoris", Sct: "Scuti", Ser: "Serpentis", Sex: "Sextantis", Tau: "Tauri", Tel: "Telescopii", Tri: "Trianguli", TrA: "Trianguli Australis",
  Tuc: "Tucanae", UMa: "Ursae Majoris", UMi: "Ursae Minoris", Vel: "Velorum", Vir: "Virginis", Vol: "Volantis", Vul: "Vulpeculae" };
const MESSIER = { "NGC 224": "M31", "NGC 598": "M33", "NGC 221": "M32", "NGC 205": "M110", "NGC 5194": "M51", "NGC 4594": "M104",
  "NGC 3031": "M81", "NGC 3034": "M82", "NGC 5055": "M63", "NGC 4826": "M64", "NGC 5236": "M83", "NGC 5457": "M101", "NGC 4258": "M106",
  "NGC 4736": "M94", "NGC 3627": "M66", "NGC 3623": "M65", "NGC 4486": "M87" };

import { LANDMARKS } from "./landmarks.js";
export { LANDMARKS };

const norm = (s) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9*+]/g, "");

function bayerAliases(desig) {
  // "Alp1 Cen" → "Alpha Centauri", "Alpha1 Centauri"
  const m = desig && desig.match(/^(\d*)\s*([A-Z][a-z]{1,2})(\d?)\s+([A-Z][A-Za-z]{2})$/);
  if (!m) return [];
  const g = GREEK[m[2]], c = CON[m[4]];
  if (!g || !c) return [];
  return [g + " " + c, g + m[3] + " " + c];
}

export class Search {
  constructor(universe, targets) {
    this.u = universe; this.t = targets;
    const E = [];
    const add = (label, sub, keys, make, rank = 0) => E.push({ label, sub, keys: keys.filter(Boolean).map(norm), make, rank });
    for (const [id, s] of universe.solar) {
      const b = s.data;
      add(b.name, { star: "Star · our Sun", planet: "Planet", dwarf: "Dwarf planet", moon: "Moon of " + (universe.solar.get(b.parent) || { data: { name: "" } }).data.name, asteroid: "Asteroid", comet: "Comet" }[b.kind],
        [b.name, id, b.id === "sun" ? "Sol" : null], () => targets.solar(id), 10);
    }
    add("Milky Way", "Barred spiral galaxy · our galaxy", ["Milky Way", "Galaxy", "MW"], () => targets.galaxy(universe.mw), 9);
    for (const s of universe.stars) {
      const names = [s.name, s.desig, ...bayerAliases(s.desig), s.hip ? "HIP " + s.hip : null, s.gaia ? "Gaia DR3 " + s.gaia : null];
      if (!s.name && !s.exoHost && s.absMag > 6 && s.src !== "HYG") continue;
      const lbl = s.name || (bayerAliases(s.desig)[0]) || s.desig;
      add(lbl, "Star · " + (s.spect ? s.spect.split(/[ +]/)[0] + " · " : "") + fmtDistance(s.distLy * LY) + (s.exoHost ? " · " + s.exoHost.planetList.length + " planet(s)" : ""),
        names, () => targets.star(s), s.name ? 5 : 1);
    }
    for (const h of universe.cat.exo.hosts) {
      if (!h.star) continue;
      for (const p of h.planetList) {
        add(p.name, "Confirmed exoplanet · host " + h.name + (h.distPc ? " · " + fmtDistance(h.distPc * 3.2616 * LY) : ""), [p.name],
          () => this.exoTarget(h, p), 3);
      }
    }
    for (const e of universe.galaxies) {
      if (e.isMW || e.rec.procedural) continue;
      const g = e.rec;
      add(g.common && g.common !== g.name ? g.common : g.name, describeMorphology(g.type, g.ttype, g.barred) + " · " + g.name + " · " + fmtDistance(g.distLy * LY),
        [g.name, g.common, MESSIER[g.name], g.name.replace(/^M(\d+)a?$/, "Messier $1")], () => targets.galaxy(e), g.common ? 6 : 2);
    }
    for (const gr of universe.groups) add(gr.name, (/Cluster/.test(gr.name) ? "Galaxy cluster" : "Galaxy group") + " · " + gr.members.length + " catalogued members", [gr.name], () => targets.group(gr), 4);
    for (const o of universe.deep) add(o.name, targets.deep(o).cls + (o.aliases.length ? " · " + o.aliases[0] : ""), [o.name, ...o.aliases], () => targets.deep(o), 6);
    for (const L of LANDMARKS) {
      if (!universe.solar.has(L.body)) continue;
      add(L.name, L.kind + " · " + universe.solar.get(L.body).data.name + " · " + fmtLatLon(L.lat, L.lon), [L.name, ...(L.aka || [])], () => targets.landmark(L), 7);
    }
    this.entries = E;
  }

  // The Earth landmark registry (space/data/earth/landmarks.json): verified
  // coordinates from Wikidata and OpenStreetMap. A registry entry replaces a
  // curated one of the same name, carrying its source-accuracy record.
  addRegistry(list) {
    for (const R of list) {
      const key = norm(R.name);
      this.entries = this.entries.filter((e) => !(e.keys.includes(key) && /Earth/.test(e.sub || "")));
      // A mountain's marker stands on its verified summit (see build-landmarks.mjs).
      const at = R.summit && R.summitSource ? R.summit : R;
      const L = { body: "earth", name: R.name, kind: (R.type || "Landmark").split(",")[0], lat: at.lat, lon: at.lon, src: R.sources.join(" + ") + (R.summitSource ? " · summit: " + R.summitSource : ""), registry: R };
      this.entries.push({ label: R.name, sub: (R.type || "Landmark").split(",")[0] + " · " + (R.country || "Earth") + " · " + fmtLatLon(R.lat, R.lon), keys: [key], make: () => this.t.landmark(L), rank: 8 });
    }
  }

  // Named places from the Earth region packs (OpenStreetMap), as landmarks.
  addPlaces(regions) {
    for (const r of regions) for (const p of r.places || []) {
      const L = { body: "earth", name: p.name, kind: p.kind, lat: p.lat, lon: p.lon, src: "OpenStreetMap contributors (ODbL)" };
      this.entries.push({ label: p.name, sub: p.kind + " · " + r.name + " · " + fmtLatLon(p.lat, p.lon), keys: [norm(p.name)], make: () => this.t.landmark(L), rank: 4 });
    }
  }

  // The HyperLEDA layer, once loaded: searchable by name, resolving to the
  // same records the renderer draws.
  addGalaxies(list, universe) {
    for (const g of list) {
      if (!/^(NGC|IC|UGC|M\d|ESO)/.test(g.name)) continue;          // named catalogues only; PGC numbers aren't useful to search
      this.entries.push({ label: g.name, sub: describeMorphology(g.type, g.ttype, g.barred) + " · " + fmtDistance(g.distLy * LY) + " · HyperLEDA",
        keys: [norm(g.name), norm(g.name.replace(" ", ""))], make: () => this.t.galaxy(universe.promoteGalaxy(g)), rank: 1 });
    }
  }

  // An exoplanet before its system is loaded: head for the host, then retarget.
  exoTarget(h, p) {
    const star = this.t.star(h.star);
    const key = starKey(h.star);
    const pa = p.aAU || 0.05;
    return {
      ...star, id: "exo:" + p.name, name: p.name, kind: "planet", real: true, cls: "Confirmed exoplanet · host " + h.name, exo: { host: h, planet: p, key },
      pos: () => {
        const sys = this.u.systems.get(key);
        const b = sys && sys.planets.find((x) => x.def.name === p.name);
        return b ? b.pos : h.star.upos;
      },
      stop: Math.max(pa * AU * 2.5, 0.05 * AU),
      info: () => ({
        rows: [["Host", h.name], ["Discovery", (p.year || U) + (p.method ? " · " + p.method : "")], ["Radius", p.radEarth !== null ? n(p.radEarth, "R⊕") : U],
          ["Mass", p.massEarth !== null ? n(p.massEarth, "M⊕") + (p.massIsMin ? " (minimum)" : "") : U], ["Orbital period", p.periodDays !== null ? n(p.periodDays, "days", 5) : U],
          ["Semi-major axis", p.aAU !== null ? n(p.aAU, "AU", 4) : U], ["Equilibrium temp.", p.teqK !== null ? n(p.teqK, "K") : U],
          ["Distance from Sol", h.distPc ? fmtDistance(h.distPc * 3.2616 * LY) : U]],
        notes: ["REAL EXOPLANET — catalogue parameters from the NASA Exoplanet Archive", "Surface visualization: procedural interpretation (appears when you arrive)"]
      })
    };
  }

  query(q, limit = 30) {
    const k = norm(q);
    if (!k) return [];
    const out = [];
    for (const e of this.entries) {
      let score = -1;
      for (const key of e.keys) {
        if (key === k) { score = Math.max(score, 100); }
        else if (key.startsWith(k)) score = Math.max(score, 60 - key.length * 0.1);
        else if (k.length >= 3 && key.includes(k)) score = Math.max(score, 30 - key.length * 0.1);
      }
      if (score >= 0) out.push({ e, score: score + e.rank });
    }
    // Discoveries (procedural systems visited), searchable by designation or your name.
    for (const [, d] of this.u.discovered) {
      if (norm(d.name).includes(k) || (d.customName && norm(d.customName).includes(k))) {
        out.push({ e: { label: d.customName || d.name, sub: "Your discovery · procedural system" + (d.customName ? " · " + d.name : ""), make: () => {
          const rec = this.u.discoveredStar(d);
          return rec ? this.t.procStar(rec) : null;
        } }, score: 50 });
      }
    }
    out.sort((a, b) => b.score - a.score);
    return out.slice(0, limit).map((o) => o.e);
  }
}

export { hashString };
