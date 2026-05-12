@echo off
SETLOCAL ENABLEDELAYEDEXPANSION

:: ── Fill in before running ───────────────────────────────────────────────────
SET FASTLY_API_TOKEN= # Fill in your Fastly API token with write permissions
SET SERVICE_ID= # Fill in your Compute@Edge service ID (from fastly.toml or Fastly dashboard)
SET VERSION= # Fill in the version number to use for VCL snippets (draft clone version)

:: The Fastly CLI command. If 'fastly' is not in your PATH, set this to the full path of the Fastly CLI executable.
SET FASTLY=C:\\path\\to\\fastly.exe

:: ─────────────────────────────────────────────────────────────────────────────


:: The directory of this script
SET COMPUTE_DIR=%~dp0

IF "!COMPUTE_DIR:~-1!"=="\" SET COMPUTE_DIR=!COMPUTE_DIR:~0,-1!

IF "%FASTLY_API_TOKEN%"==""    ( ECHO Fill in FASTLY_API_TOKEN at the top of this script.    & GOTO :EOF )
IF "%SERVICE_ID%"==""          ( ECHO Fill in SERVICE_ID at the top of this script.           & GOTO :EOF )

:: Create config store
ECHO --- Creating cheq_rti_config Config Store ---
%FASTLY% config-store create --name cheq_rti_config 2>nul || ECHO (config store already exists)

:: Create backends.
:: [setup.backends] in fastly.toml only runs on first deploy to a new service.
:: This command ensures the backend exists when redeploying to an existing service.
ECHO --- Creating recaptcha_backend ---
%FASTLY% backend create --service-id "%SERVICE_ID%" --version "%VERSION%" --name recaptcha_backend --address www.google.com --port 443 --use-ssl --ssl-cert-hostname www.google.com --ssl-sni-hostname www.google.com || ECHO (recaptcha_backend may already exist)

:: Build and deploy
ECHO --- Building node ---
npm install --prefix "%COMPUTE_DIR%"

ECHO --- Building wasm ---
%FASTLY% compute build

ECHO --- Deploying ---
%FASTLY% compute deploy --accept-defaults

ECHO Done.
ENDLOCAL
