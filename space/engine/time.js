// Simulation time, decoupled from frame rate. Held as a Julian Date in
// float64 days, advanced by real elapsed seconds × the chosen rate.

export const RATES = [
  { label: "Pause", k: 0 },
  { label: "1×", k: 1 },
  { label: "10×", k: 10 },
  { label: "100×", k: 100 },
  { label: "1000×", k: 1000 },
  { label: "1 day/s", k: 86400 },
  { label: "1 yr/s", k: 31557600 }
];

export function jdFromDate(d) { return d.getTime() / 86400000 + 2440587.5; }
export function dateFromJd(jd) { return new Date((jd - 2440587.5) * 86400000); }

export class TimeController {
  constructor() {
    this.jd = jdFromDate(new Date());
    this.rateIndex = 1;
  }
  get rate() { return RATES[this.rateIndex].k; }
  get paused() { return this.rate === 0; }
  setRate(i) { this.rateIndex = Math.max(0, Math.min(RATES.length - 1, i)); }
  faster() { this.setRate(this.rateIndex + 1); }
  slower() { this.setRate(this.rateIndex - 1); }
  togglePause() { this._resume = this.paused ? this._resume || 1 : this.rateIndex; this.setRate(this.paused ? this._resume : 0); }
  now() { this.jd = jdFromDate(new Date()); }
  step(realDt) { this.jd += (realDt * this.rate) / 86400; }
  // Centuries since J2000 and days since J2000, the two clocks the ephemerides use.
  get T() { return (this.jd - 2451545.0) / 36525; }
  get d() { return this.jd - 2451545.0; }
  label() {
    const d = dateFromJd(this.jd);
    return d.toISOString().replace("T", " ").slice(0, 19) + " UTC";
  }
}
