# DATA.md

Public datasets only. No client data, no PII. Record source + license **before** use.

| Dataset | Source | License | Use in this project |
|---|---|---|---|
| CUAD | The Atticus Project — https://www.atticusprojectai.org/cuad · HF `theatticusproject/cuad-qa` | CC BY 4.0 (credit The Atticus Project) | Gold clause-extraction spans → corpus + eval candidates |
| ContractNLI | https://stanfordnlp.github.io/contract-nli/ | CC BY 4.0 — **confirm against the dataset's LICENSE/README on download and record the exact string here** | NDA hypotheses (entail/contradict/not-mentioned) + evidence spans → NDA corpus + risk-flag eval candidates |

Planned later (not ingested in Phase 0): LEDGAR (LexGLUE, fine-tuning), LegalBench-RAG
(retrieval ground truth), LegalBench (reasoning), SEC EDGAR (demo + lease expansion).

## Verification
On first download, confirm each license from the dataset's own LICENSE/README and update
the table above with the exact license string and the date confirmed. Do not ingest a
dataset whose license has not been recorded here.

## Storage
Raw downloads land in `data/raw/<source>/` and normalized artifacts in
`data/processed/<source>/`. Both are gitignored — regenerate with `make ingest && make parse`.
