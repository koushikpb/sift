import { indexAllClauses } from "./indexClauses.js";
import { EMBED_MODEL } from "./model.js";

const { embedded } = await indexAllClauses();
console.log(`embedded ${embedded} clauses (model=${EMBED_MODEL})`);
process.exit(0);
