@echo off
SETLOCAL ENABLEDELAYEDEXPANSION

:: ── Fill in before running ───────────────────────────────────────────────────
SET FASTLY_API_TOKEN= # Fill in your Fastly API token with write permissions
SET VERSION= # Fill in the version number to use for VCL snippets (draft clone version)
:: ─────────────────────────────────────────────────────────────────────────────

:: The Fastly CLI command. If 'fastly' is not in your PATH, set this to the full path of the Fastly CLI executable.
SET FASTLY=fastly

:: The directory of this script
SET COMPUTE_DIR=%~dp0

IF "!COMPUTE_DIR:~-1!"=="\" SET COMPUTE_DIR=!COMPUTE_DIR:~0,-1!

IF "%FASTLY_API_TOKEN%"==""    ( ECHO Fill in FASTLY_API_TOKEN at the top of this script.    & GOTO :EOF )

:: Create config store
ECHO --- Creating cheq_rti_config Config Store ---
%FASTLY% config-store create --name cheq_rti_config 2>nul || ECHO (config store already exists)

:: Build and deploy (fastly.toml [setup.config_stores] handles linking automatically)
ECHO --- Building node ---
npm install --prefix "%COMPUTE_DIR%"

ECHO --- Building wasm ---
%FASTLY% compute build

ECHO --- Deploying ---
%FASTLY% compute deploy --accept-defaults

ECHO Done.
ENDLOCAL
