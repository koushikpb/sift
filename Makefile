PY := pipeline/.venv/bin/python
PIP := pipeline/.venv/bin/pip

.PHONY: py-test py-lint
py-test:
	cd pipeline && .venv/bin/python -m pytest -q
py-lint:
	cd pipeline && .venv/bin/python -m ruff check .
