@echo off
REM Windows batch variant to upload Fastly snippets for this repo
REM Usage: edit SERVICE_ID, VERSION, and FASTLY path, then run from cmd.exe

SET SERVICE_ID= Fill in your Fastly Service ID 
SET VERSION= Fill in the version number to use for VCL snippets (draft clone version)
SET FASTLY=C:\\path\\to\\fastly.exe
SET SNIPPETS=%~dp0snippets

IF "%SERVICE_ID%"=="" (
  ECHO Please set SERVICE_ID in this file or pass it as an environment variable.
  GOTO :EOF
)
IF "%VERSION%"=="" (
  ECHO Please set VERSION (draft cloned version) in this file.
  GOTO :EOF
)

:: Create backends (multiline for readability)
%FASTLY% backend create --service-id "%SERVICE_ID%" --version "%VERSION%" ^
  --name F_cheq_rti_backend ^
  --address rti-global.cheqzone.com ^
  --port 443 ^
  --use-ssl ^
  --ssl-cert-hostname rti-global.cheqzone.com ^
  --ssl-sni-hostname rti-global.cheqzone.com ^
  --autoclone=false || echo F_cheq_rti_backend may exist

%FASTLY% backend create --service-id "%SERVICE_ID%" --version "%VERSION%" ^
  --name F_cheq_captcha_backend ^
  --address entirely-wanted-colt.edgecompute.app ^
  --port 443 ^
  --use-ssl ^
  --ssl-cert-hostname entirely-wanted-colt.edgecompute.app ^
  --ssl-sni-hostname entirely-wanted-colt.edgecompute.app ^
  --autoclone=false || echo F_cheq_captcha_backend may exist

%FASTLY% backend create --service-id "%SERVICE_ID%" --version "%VERSION%" ^
  --name F_origin_backend ^
  --address tel-aviv.blog ^
  --port 443 ^
  --use-ssl ^
  --ssl-cert-hostname tel-aviv.blog ^
  --ssl-sni-hostname tel-aviv.blog ^
  --autoclone=false || echo F_origin_backend may exist

:: Create dictionaries
%FASTLY% dictionary create --service-id "%SERVICE_ID%" --version "%VERSION%" --name general_config --autoclone=false || echo general_config may exist
%FASTLY% dictionary create --service-id "%SERVICE_ID%" --version "%VERSION%" --name challenge_tt_codes --autoclone=false || echo challenge_tt_codes may exist
%FASTLY% dictionary create --service-id "%SERVICE_ID%" --version "%VERSION%" --name redirect_tt_codes --autoclone=false || echo redirect_tt_codes may exist
%FASTLY% dictionary create --service-id "%SERVICE_ID%" --version "%VERSION%" --name block_tt_codes --autoclone=false || echo block_tt_codes may exist
%FASTLY% dictionary create --service-id "%SERVICE_ID%" --version "%VERSION%" --name ignored_paths_config --autoclone=false || echo ignored_paths_config may exist

:: Optional: create a compute config store (Edge Dictionary) used by Compute@Edge
%FASTLY% dictionary create --service-id "%SERVICE_ID%" --version "%VERSION%" --name compute_config --autoclone=false || echo compute_config may exist

%FASTLY% vcl snippet create --service-id "%SERVICE_ID%" --version "%VERSION%" --name=cheq_rti_init    --type=none    --priority=10 --content="%SNIPPETS%\init.vcl"
%FASTLY% vcl snippet create --service-id "%SERVICE_ID%" --version "%VERSION%" --name=cheq_rti_recv    --type=recv    --priority=10 --content="%SNIPPETS%\recv.vcl"
%FASTLY% vcl snippet create --service-id "%SERVICE_ID%" --version "%VERSION%" --name=cheq_rti_pass    --type=pass    --priority=10 --content="%SNIPPETS%\pass.vcl"
%FASTLY% vcl snippet create --service-id "%SERVICE_ID%" --version "%VERSION%" --name=cheq_rti_fetch   --type=fetch   --priority=10 --content="%SNIPPETS%\fetch.vcl"
%FASTLY% vcl snippet create --service-id "%SERVICE_ID%" --version "%VERSION%" --name=cheq_rti_deliver --type=deliver --priority=10 --content="%SNIPPETS%\deliver.vcl"
%FASTLY% vcl snippet create --service-id "%SERVICE_ID%" --version "%VERSION%" --name=cheq_rti_error   --type=error   --priority=10 --content="%SNIPPETS%\error.vcl"

ECHO Snippet upload commands executed. Review output for errors.

:: NOTE: This VCL setup script is intentionally VCL-only. Compute build/deploy
:: is handled by the dedicated compute setup script: ..\compute\setup_compute.cmd
