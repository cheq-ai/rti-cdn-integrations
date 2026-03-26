@echo off
SETLOCAL ENABLEDELAYEDEXPANSION

:: ── Fill in before running ───────────────────────────────────────────────────
SET FASTLY_API_TOKEN= # Fill in your Fastly API token with write permissions
SET VERSION= # Fill in the version number to use for VCL snippets (draft clone version)
::SET RECAPTCHA_SECRET_KEY=
SET DEBUGGING_ENABLED=false
:: ─────────────────────────────────────────────────────────────────────────────

SET FASTLY=fastly
SET COMPUTE_DIR=%~dp0
IF "!COMPUTE_DIR:~-1!"=="\" SET COMPUTE_DIR=!COMPUTE_DIR:~0,-1!

IF "%FASTLY_API_TOKEN%"==""    ( ECHO Fill in FASTLY_API_TOKEN at the top of this script.    & GOTO :EOF )
::IF "%RECAPTCHA_SECRET_KEY%"=="" ( ECHO Fill in RECAPTCHA_SECRET_KEY at the top of this script. & GOTO :EOF )

:: Create config store
ECHO --- Creating cheq_rti_config Config Store ---
%FASTLY% config-store create --name cheq_rti_config 2>nul || ECHO (config store already exists)

:: Write entries
:: For now create the entries manually
::ECHO --- Writing Config Store entries ---
::%FASTLY% config-store-entry create --store-id "%STORE_ID%" --key recaptcha_secret_key --value "%RECAPTCHA_SECRET_KEY%" 2>nul || %FASTLY% config-store-entry update --store-id "%STORE_ID%" --key recaptcha_secret_key --value "%RECAPTCHA_SECRET_KEY%"
::%FASTLY% config-store-entry create --store-id "%STORE_ID%" --key debugging_enabled    --value "%DEBUGGING_ENABLED%"    2>nul || %FASTLY% config-store-entry update --store-id "%STORE_ID%" --key debugging_enabled    --value "%DEBUGGING_ENABLED%"

:: Build and deploy (fastly.toml [setup.config_stores] handles linking automatically)
ECHO --- Building ---
npm install --prefix "%COMPUTE_DIR%"
%FASTLY% compute build --directory "%COMPUTE_DIR%"

ECHO --- Deploying ---
%FASTLY% compute deploy --directory "%COMPUTE_DIR%" --accept-defaults

ECHO Done.
ENDLOCAL
