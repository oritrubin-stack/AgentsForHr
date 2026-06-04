# System Instructions for Claude Code (AI Recruitment Agent Project)

## Project Overview
This project is an AI-driven Recruitment System designed to find, extract, and analyze software and hardware candidates across multiple platforms (e.g., LinkedIn, Drushim IL). The system uses a Multi-Agent Architecture (Hunter, Analyzer, Orchestrator) to separate concerns. The UI is designed for HR professionals, meaning all underlying AI and scraping complexity must be fully abstracted behind clean APIs.

## Tech Stack
- **Runtime:** Node.js
- **Language:** TypeScript
- **Web Framework:** Express.js
- **AI & Agents:** LangChain.js / Custom Agent Logic, Skills IL (for Israeli market context)
- **Scraping/Automation:** Playwright
- **Tooling:** dotenv, ts-node, nodemon

## Architecture & Directory Structure
Adhere to Clean Architecture principles:
- `src/api/`: Express Routes, Controllers, and Middlewares.
- `src/agents/`: Agent logic (Orchestrator, Scraper/Hunter, Analyzer).
- `src/services/`: External integrations (LLM APIs, Skills IL, Playwright instances).
- `src/config/`: Environment variables validation and system settings.

## Coding Standards
- Write professional, highly modular, and production-grade TypeScript code.
- Enforce strict typing; avoid the use of `any`.
- Adhere strictly to the Single Responsibility Principle (SRP).
- Write comprehensive JSDoc comments for interfaces, classes, and complex business logic.
- Maintain a professional tone in all code, using standard industry terminology.