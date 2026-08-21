/**
 * JSON-file persistence for the two leaderboards.
 *
 * The committed files in data/ are the seed dataset; the live store copies
 * them into a writable data directory (default server/.data, override with
 * MAKEFASTER_DATA_DIR) on first boot and owns them from then on. Writes are
 * atomic (temp file + rename) so a crash can never leave a torn JSON file,
 * and the HTML tables can refresh from GET /data/*.json at any time.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

export class Store {
  /**
   * @param {{dataDir: string, seedDir: string}} args
   *  dataDir — writable directory owned by the store
   *  seedDir — directory holding the committed sites.json / improvements.json
   */
  constructor({ dataDir, seedDir }) {
    this.dataDir = dataDir;
    this.seedDir = seedDir;
    mkdirSync(dataDir, { recursive: true });
    this.sites = this.#loadCollection("sites.json");
    this.improvements = this.#loadCollection("improvements.json");
  }

  #loadCollection(filename) {
    const livePath = join(this.dataDir, filename);
    if (existsSync(livePath)) {
      return JSON.parse(readFileSync(livePath, "utf8"));
    }
    const seedPath = join(this.seedDir, filename);
    const seeded = existsSync(seedPath) ? JSON.parse(readFileSync(seedPath, "utf8")) : [];
    this.#persist(filename, seeded);
    return seeded;
  }

  #persist(filename, rows) {
    const target = join(this.dataDir, filename);
    const temp = join(this.dataDir, `.${filename}.${process.pid}.tmp`);
    writeFileSync(temp, JSON.stringify(rows, null, 1) + "\n");
    renameSync(temp, target);
  }

  getSites() {
    return this.sites;
  }

  getImprovements() {
    return this.improvements;
  }

  replaceSites(rows) {
    this.sites = rows;
    this.#persist("sites.json", rows);
  }

  replaceImprovements(rows) {
    this.improvements = rows;
    this.#persist("improvements.json", rows);
  }
}
