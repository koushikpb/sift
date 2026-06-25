import { loadDocsFile } from "./loadDocs.js";

const sources = ["cuad", "contractnli"];
const root = new URL("../../../", import.meta.url).pathname;

const counts = { documents: 0, clauses: 0 };
for (const s of sources) {
  const path = `${root}data/processed/${s}/docs.jsonl`;
  try {
    const r = await loadDocsFile(path);
    counts.documents += r.documents;
    counts.clauses += r.clauses;
    console.log(`loaded ${s}: ${r.documents} docs, ${r.clauses} clauses`);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      console.warn(`skip ${s}: ${path} not found (run make ingest && make parse first)`);
    } else {
      throw e;
    }
  }
}
console.log(`total: ${counts.documents} docs, ${counts.clauses} clauses`);
process.exit(0);
