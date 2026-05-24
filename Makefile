# vdx — convenience aliases over `mise run <verb>`.
# Source of truth for tasks is mise.toml (the manifest the CLI projects into
# AGENTS.md). This Makefile exists so a stranger can `make test` without
# learning mise first.

.PHONY: build test check audit smoke help

help:
	@echo "vdx tasks (delegated to mise):"
	@echo "  make build   — typecheck cli/"
	@echo "  make test    — vitest run in cli/"
	@echo "  make check   — typecheck + tests"
	@echo "  make audit   — self-audit against canonical rubric"
	@echo "  make smoke   — audit the 3 calibration reference projects"

build:
	cd cli && npm run typecheck

test:
	cd cli && npm test

check: build test

audit:
	cd cli && npx tsx src/index.ts audit ..

smoke:
	cd cli && bash smoke.sh
