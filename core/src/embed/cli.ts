import { indexAllClauses } from "./indexClauses.js";

const { embedded } = await indexAllClauses();
console.log(`embedded ${embedded} clauses (model=bge-large-en-v1.5)`);
process.exit(0);
