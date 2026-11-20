// Stellar physics used to turn catalogue numbers into renderable stars, and
// to give procedural stars self-consistent properties. Values derived here
// for real stars are flagged as estimates in the info panel.

export const T_SUN = 5772;
export const MBOL_SUN = 4.74;

// Effective temperature from B−V (Ballesteros 2012).
export function teffFromBV(bv) {
  return 4600 * (1 / (0.92 * bv + 1.7) + 1 / (0.92 * bv + 0.62));
}
// From Gaia BP−RP, via an approximate BP−RP → B−V relation.
export function teffFromBpRp(bprp) {
  const bv = Math.max(-0.4, Math.min(2.2, 0.0981 + 0.6206 * bprp - 0.0283 * bprp * bprp));
  return teffFromBV(bv);
}

// Bolometric correction for V (Flower 1996, as corrected by Torres 2010).
export function bolometricCorrection(T) {
  const lt = Math.log10(Math.max(2000, Math.min(50000, T)));
  let c;
  if (lt < 3.7) c = [-0.190537291496456e5, 0.155144866764412e5, -0.421278819301717e4, 0.381476328422343e3];
  else if (lt < 3.9) c = [-0.370510203809015e5, 0.385672629965804e5, -0.150651486316025e5, 0.261724637119416e4, -0.170623810323864e3];
  else c = [-0.118115450538963e6, 0.137145973583929e6, -0.636233812100225e5, 0.147412923562646e5, -0.170587278406872e4, 0.788731721804990e2];
  let bc = 0, p = 1;
  for (const k of c) { bc += k * p; p *= lt; }
  return bc;
}

export function lumFromAbsV(absV, T) {
  return Math.pow(10, -0.4 * (absV + bolometricCorrection(T) - MBOL_SUN));
}
export function radiusFromLumT(L, T) {
  return Math.sqrt(L) / Math.pow(T / T_SUN, 2);
}
// Main-sequence mass from luminosity (piecewise mass–luminosity relation).
export function massFromLum(L) {
  if (L < 0.033) return Math.pow(L / 0.23, 1 / 2.3);
  if (L < 16) return Math.pow(L, 1 / 4);
  if (L < 54000) return Math.pow(L / 1.4, 1 / 3.5);
  return L / 32000;
}

export function spectralClass(T) {
  if (T >= 30000) return "O";
  if (T >= 10000) return "B";
  if (T >= 7500) return "A";
  if (T >= 6000) return "F";
  if (T >= 5200) return "G";
  if (T >= 3700) return "K";
  return "M";
}
// Subclass 0–9 within the letter, from temperature.
export function spectralType(T) {
  const edges = { O: [50000, 30000], B: [30000, 10000], A: [10000, 7500], F: [7500, 6000], G: [6000, 5200], K: [5200, 3700], M: [3700, 2300] };
  const c = spectralClass(T);
  const [hi, lo] = edges[c];
  const sub = Math.max(0, Math.min(9, Math.floor(((hi - T) / (hi - lo)) * 10)));
  return c + sub;
}

// Luminosity class from a catalogue spectral string, e.g. "K1.5IIIFe-0.5".
export function luminosityClass(spect) {
  if (!spect) return null;
  if (/^D/.test(spect)) return "D";
  const m = spect.match(/(Iab|Ia|Ib|III|II|IV|VI|V|I)(?![A-Za-z])/);
  return m ? m[1] : null;
}
export function describeClass(lc) {
  return {
    Ia: "luminous supergiant", Iab: "supergiant", Ib: "supergiant", I: "supergiant", II: "bright giant",
    III: "giant", IV: "subgiant", V: "main-sequence star", VI: "subdwarf", D: "white dwarf"
  }[lc] || null;
}

// Blackbody colour in linear RGB, normalised so the brightest channel is 1.
// Fit to CIE 1931 2° integrations of the Planck function (Mitchell Charity's
// table), which is what makes the Sun come out white rather than yellow.
export function tempToRGB(T) {
  const t = Math.max(1000, Math.min(40000, T)) / 100;
  let r, g, b;
  if (t <= 66) {
    r = 255;
    g = 99.4708025861 * Math.log(t) - 161.1195681661;
    b = t <= 19 ? 0 : 138.5177312231 * Math.log(t - 10) - 305.0447927307;
  } else {
    r = 329.698727446 * Math.pow(t - 60, -0.1332047592);
    g = 288.1221695283 * Math.pow(t - 60, -0.0755148492);
    b = 255;
  }
  const c = (v) => Math.pow(Math.max(0, Math.min(255, v)) / 255, 2.2);
  const out = [c(r), c(g), c(b)];
  const m = Math.max(out[0], out[1], out[2]);
  return [out[0] / m, out[1] / m, out[2] / m];
}

export function absMagToLumV(absV) { return Math.pow(10, -0.4 * (absV - 4.83)); }

// Habitable-zone edges in AU for a luminosity (Kasting-style conservative bounds).
export function habitableZone(L) {
  return [Math.sqrt(L / 1.1), Math.sqrt(L / 0.53)];
}
// Equilibrium temperature at distance a (AU) for albedo A.
export function equilibriumTemp(L, aAU, albedo) {
  return 278.6 * Math.pow(L, 0.25) * Math.pow(1 - albedo, 0.25) / Math.sqrt(aAU);
}
