@echo off
REM Windows batch variant to upload Fastly snippets for this repo
REM Usage: edit SERVICE_ID, VERSION, and FASTLY path, then run from cmd.exe

SET SERVICE_ID= Fill in your Fastly Service ID 
SET VERSION= Fill in the version number to use for VCL snippets (draft clone version)
SET FASTLY=C:\\path\\to\\fastly.exe
SET SNIPPETS=%~dp0snippets

ECHO Create backends

:: This is the cheq api endpoint, nothing should be changed here
%FASTLY% backend create --service-id "%SERVICE_ID%" --version "%VERSION%" --name cheq_rti_backend --address rti-global.cheqzone.com --port 443 --use-ssl --ssl-cert-hostname rti-global.cheqzone.com --ssl-sni-hostname rti-global.cheqzone.com || echo F_cheq_rti_backend may exist

:: This is the captcha endpoint, used for the captcha flow.
:: Set --address, --ssl-cert-hostname, and --ssl-sni-hostname to your captcha service hostname.
:: Do not modify --name.
%FASTLY% backend create --service-id "%SERVICE_ID%" --version "%VERSION%" --name cheq_captcha_backend --address your-captcha-service-hostname.com --port 443 --use-ssl --ssl-cert-hostname your-captcha-service-hostname.com --ssl-sni-hostname your-captcha-service-hostname.com || echo F_cheq_captcha_backend may exist

:: This is your origin backend.
:: Set --address, --ssl-cert-hostname, and --ssl-sni-hostname to your origin hostname.
:: Do not modify --name.
%FASTLY% backend create --service-id "%SERVICE_ID%" --version "%VERSION%" --name origin_backend --address your-origin-hostname.com --port 443 --use-ssl --ssl-cert-hostname your-origin-hostname.com --ssl-sni-hostname your-origin-hostname.com || echo F_origin_backend may exist

:: Create dictionaries
%FASTLY% dictionary create --service-id "%SERVICE_ID%" --version "%VERSION%" --name general_config || echo general_config may exist
%FASTLY% dictionary create --service-id "%SERVICE_ID%" --version "%VERSION%" --name challenge_tt_codes || echo challenge_tt_codes may exist
%FASTLY% dictionary create --service-id "%SERVICE_ID%" --version "%VERSION%" --name redirect_tt_codes || echo redirect_tt_codes may exist
%FASTLY% dictionary create --service-id "%SERVICE_ID%" --version "%VERSION%" --name block_tt_codes || echo block_tt_codes may exist
%FASTLY% dictionary create --service-id "%SERVICE_ID%" --version "%VERSION%" --name ignored_paths_config || echo ignored_paths_config may exist

:: Create Snippets
%FASTLY% vcl snippet create --service-id "%SERVICE_ID%" --version "%VERSION%" --name=cheq_rti_init    --type=init    --priority=10 --content="%SNIPPETS%\init.vcl"
%FASTLY% vcl snippet create --service-id "%SERVICE_ID%" --version "%VERSION%" --name=cheq_rti_recv    --type=recv    --priority=10 --content="%SNIPPETS%\recv.vcl"
%FASTLY% vcl snippet create --service-id "%SERVICE_ID%" --version "%VERSION%" --name=cheq_rti_pass    --type=pass    --priority=10 --content="%SNIPPETS%\pass.vcl"
%FASTLY% vcl snippet create --service-id "%SERVICE_ID%" --version "%VERSION%" --name=cheq_rti_fetch   --type=fetch   --priority=10 --content="%SNIPPETS%\fetch.vcl"
%FASTLY% vcl snippet create --service-id "%SERVICE_ID%" --version "%VERSION%" --name=cheq_rti_deliver --type=deliver --priority=10 --content="%SNIPPETS%\deliver.vcl"
%FASTLY% vcl snippet create --service-id "%SERVICE_ID%" --version "%VERSION%" --name=cheq_rti_error   --type=error   --priority=10 --content="%SNIPPETS%\error.vcl"

ECHO Snippet upload commands executed. Review output for errors (if exists).

:: NOTE: This VCL setup script is intentionally VCL-only. Compute build/deploy
:: is handled by the dedicated compute setup script: ..\compute\setup_compute.cmd
