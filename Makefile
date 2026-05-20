.PHONY: up down restart logs ps test test-backend test-frontend typecheck smoke resume clean help

# Default target prints help.
.DEFAULT_GOAL := help

help: ## Show this help.
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-15s\033[0m %s\n", $$1, $$2}'

up: ## Build frontend (if stale) and start all four services.
	@bash scripts/up.sh

down: ## Stop and remove all containers.
	docker compose down

restart: ## Restart api and worker (picks up backend code changes via volume mount).
	docker compose restart api worker

logs: ## Tail logs from api and worker.
	docker compose logs -f api worker

ps: ## Show service status.
	docker compose ps

test: test-backend test-frontend ## Run all unit tests (backend + frontend).

test-backend: ## Run pytest in the backend venv.
	cd backend && .venv/bin/pytest

test-frontend: ## Run vitest.
	cd frontend && npm test

typecheck: ## TypeScript strict check (no emit).
	cd frontend && npm run typecheck

smoke: ## End-to-end smoke test (requires `make up` first).
	backend/.venv/bin/python scripts/smoke_test.py

resume: ## Resume test (mid-batch worker restart).
	backend/.venv/bin/python scripts/resume_test.py

clean: ## Remove dist/, runtime data/, and Python caches.
	rm -rf frontend/dist frontend/.vite
	rm -rf data
	find backend -type d -name __pycache__ -exec rm -rf {} +
	find backend -type d -name .pytest_cache -exec rm -rf {} +
	find backend -type d -name '*.egg-info' -exec rm -rf {} +
