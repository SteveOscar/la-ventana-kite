const KEY = 'la-ventana-logbook-v1';

export interface LogbookData {
  species: string[];
  landmarks: string[];
  tricks: string[];
  sessions: number;
  bestScore: number;
  bestHeight: number;
  bestAirtime: number;
  schoolDone: boolean;
  downwinderBest: number | null;
  raceBest: number | null;
  settings: { volume: number; quality: 'high' | 'medium'; assisted: boolean };
}

const EMPTY: LogbookData = {
  species: [],
  landmarks: [],
  tricks: [],
  sessions: 0,
  bestScore: 0,
  bestHeight: 0,
  bestAirtime: 0,
  schoolDone: false,
  downwinderBest: null,
  raceBest: null,
  settings: { volume: 0.8, quality: 'high', assisted: true },
};

/** Persistent progress in localStorage. */
export class Logbook {
  data: LogbookData;

  constructor() {
    this.data = { ...EMPTY, settings: { ...EMPTY.settings } };
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as Partial<LogbookData>;
        this.data = { ...this.data, ...parsed, settings: { ...EMPTY.settings, ...(parsed.settings ?? {}) } };
      }
    } catch {
      // Private browsing or corrupt data: start a fresh logbook.
    }
  }

  save() {
    try {
      localStorage.setItem(KEY, JSON.stringify(this.data));
    } catch {
      // Storage unavailable; progress lives for this page only.
    }
  }

  private addTo(list: 'species' | 'landmarks' | 'tricks', id: string) {
    if (this.data[list].includes(id)) return false;
    this.data[list].push(id);
    this.save();
    return true;
  }

  addSpecies(id: string) {
    return this.addTo('species', id);
  }

  addLandmark(id: string) {
    return this.addTo('landmarks', id);
  }

  addTrick(id: string) {
    return this.addTo('tricks', id);
  }

  recordSession(score: number, height: number, airtime: number) {
    this.data.sessions++;
    this.data.bestScore = Math.max(this.data.bestScore, score);
    this.data.bestHeight = Math.max(this.data.bestHeight, height);
    this.data.bestAirtime = Math.max(this.data.bestAirtime, airtime);
    this.save();
  }
}
