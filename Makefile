# Makefile for qwen-code

.PHONY: help install build build-sandbox build-all test lint format preflight clean start debug create-alias

help:
	@echo "Makefile for qwen-code"
	@echo ""
	@echo "Usage:"
	@echo "  make install          - Install npm dependencies"
	@echo "  make build            - Build the main project"
	@echo "  make build-all        - Build the main project and sandbox"
	@echo "  make test             - Run the test suite"
	@echo "  make lint             - Lint the code"
	@echo "  make format           - Format the code"
	@echo "  make preflight        - Run formatting, linting, and tests"
	@echo "  make clean            - Remove generated files"
	@echo "  make start            - Start the Qwen Code CLI"
	@echo "  make debug            - Start the Qwen Code CLI in debug mode"
	@echo ""
	@echo "  make create-alias     - Create a 'qwen' alias for your shell"

install:
	npm install

build:
	npm run build


build-all:
	npm run build:all

test:
	npm run test

lint:
	npm run lint

format:
	npm run format

preflight:
	npm run preflight

clean:
	npm run clean

start:
	npm run start

debug:
	npm run debug


create-alias:
	scripts/create_alias.sh
