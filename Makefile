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
