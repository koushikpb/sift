PY := pipeline/.venv/bin/python
PIP := pipeline/.venv/bin/pip

.PHONY: py-test py-lint
py-test:
	cd pipeline && .venv/bin/python -m pytest -q
py-lint:
	cd pipeline && .venv/bin/python -m ruff check .

.PHONY: ts-test ts-typecheck
ts-test:
	cd core && npm test
ts-typecheck:
	cd core && npm run typecheck

.PHONY: migrate
migrate:
	cd core && npm run migrate

.PHONY: load
load:
	cd core && npm run load

.PHONY: db-up db-down
db-up:
	docker compose up -d db
	@echo "waiting for postgres..."
	@until docker compose exec -T db pg_isready -U sift -d sift >/dev/null 2>&1; do sleep 1; done
	@echo "postgres ready on localhost:5433"
db-down:
	docker compose down

.PHONY: ingest parse
ingest:
	cd pipeline && .venv/bin/python -m pipeline.cli ingest
parse:
	cd pipeline && .venv/bin/python -m pipeline.cli parse

.PHONY: eval-derive eval-validate
eval-derive:
	cd core && npm run eval -- derive
eval-validate:
	cd core && npm run eval -- validate

.PHONY: verify-p0
verify-p0: db-up migrate
	@echo "== 1/3 parser hierarchy gate (10 contracts) =="
	cd pipeline && .venv/bin/python -m pytest tests/test_parse_gate.py -q
	@echo "== 2/3 corpus loaded =="
	cd core && npm run load
	@echo "== 3/3 eval set v1 (50 items) =="
	cd core && npm run eval -- validate
	@echo "PHASE 0 GATE PASSED"
