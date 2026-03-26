# CHEQ RTI – VCL Snippets

VCL Snippets are the **recommended deployment method** for this integration. They inject small pieces of VCL into specific Fastly lifecycle hooks without requiring you to manage a full custom VCL file. They work alongside any existing VCL on your service.

For full integration documentation, architecture details, and configuration reference, see the [main README](../README.md).

---

## Files

| File           | Snippet type | Priority | Description                                     |
|----------------|--------------|----------|-------------------------------------------------|
| `init.vcl`     | `none`       | 10       | All CHEQ RTI subroutine definitions             |
| `recv.vcl`     | `recv`       | 10       | Session check + bypass + `cheq_rti_recv`        |
| `pass.vcl`     | `pass`       | 10       | `cheq_rti_backend_fetch`                        |
| `fetch.vcl`    | `fetch`      | 10       | `cheq_rti_backend_response` (skipped on bypass) |
| `deliver.vcl`  | `deliver`    | 10       | `cheq_rti_deliver`                              |
| `error.vcl`    | `error`      | 10       | `cheq_rti_synth` (block / redirect / challenge) |
| `init-slim.vcl`| `none`       | 10       | Comment-stripped version of `init.vcl` for upload (see below) |

---

## ⚠️ The 32 KB size limit — create `init-slim.vcl` before uploading

Fastly enforces a **32 KB maximum** on VCL snippet content. `init.vcl` contains extensive inline documentation and exceeds this limit (~53 KB). You must strip the comments before uploading.

Run this once to generate `init-slim.vcl`:

```cmd
powershell -Command "(Get-Content 'snippets\init.vcl') | Where-Object { $_ -notmatch '^\s*#' } | Set-Content 'snippets\init-slim.vcl'"
```

Check the size (must be < 32768 bytes):
```cmd
powershell -Command "(Get-Item 'snippets\init-slim.vcl').Length"
```

**Always upload `init-slim.vcl` instead of `init.vcl`.**  
`init.vcl` is the source of truth — edit it, then re-run the strip command to regenerate `init-slim.vcl`.

---

## Before you upload — required setup

### 1. Set the backend names

The snippets reference three backends. All names use the **`F_` prefix** that Fastly automatically applies to every backend you create in the UI or API. If your backend is named `my_site` in the Fastly UI, you must write `F_my_site` in VCL.

| Backend identifier used in snippets | Default name expected | Where to change | Required? |
|--------------------------------------|-----------------------|-----------------|-----------|
| `F_origin_backend` | Backend named `origin_backend` in Fastly | `recv.vcl` + `init.vcl` line with `set req.backend` | **Always** |
| `F_cheq_rti_backend` | Backend named `cheq_rti_backend` pointing to `rti-global.cheqzone.com` | `init.vcl` — `cheq_rti_recv` subroutine | Only if you renamed the backend |
| `F_cheq_captcha_backend` | Backend named `cheq_captcha_backend` pointing to your Compute@Edge service | `init.vcl` — `cheq_rti_synth` subroutine | Only when using `captcha` strategy |

**To change a backend name**, find and replace the identifier in `init.vcl` (then regenerate `init-slim.vcl`), and for `F_origin_backend` also update `recv.vcl`:

```vcl
# Example: your origin backend is named "www_example_com" in the Fastly UI
set req.backend = F_www_example_com;
```

> If you keep the default names (`origin_backend`, `cheq_rti_backend`, `cheq_captcha_backend`) when creating the backends in Fastly, no changes are needed.

### 2. Create the Edge Dictionaries

All 5 dictionaries must exist in your Fastly service before the VCL will compile. Go to **Data → Dictionaries** and create:

| Dictionary name        | Can be empty? | Purpose                                             |
|------------------------|---------------|-----------------------------------------------------|
| `general_config`       | ❌            | `api_key`, `tag_hash`, `mode`, strategies, etc.     |
| `ignored_paths_config` | ✅            | Paths that bypass RTI; key = path, value = `1`      |
| `block_tt_codes`       | ✅            | TT codes → force block; key = integer, value = `1`  |
| `challenge_tt_codes`   | ✅            | TT codes → force challenge                          |
| `redirect_tt_codes`    | ✅            | TT codes → force redirect                           |

See [general_config key reference](../README.md#general_config-dictionary) in the main README.

### 3. Add the reCAPTCHA domain

If using `captcha` strategy, add your Fastly service domain to your **Google reCAPTCHA site key** at [g.co/recaptcha/admin](https://www.google.com/recaptcha/admin) → select site key → Domains → add hostname.

---

## Uploading via CMD

```cmd
set SERVICE_ID=<your_service_id>
set VERSION=<draft_version_number>
set FASTLY=<path_to_fastly.exe>
set SNIPPETS=<path_to_this_snippets_folder>

%FASTLY% vcl snippet create --service-id="%SERVICE_ID%" --version="%VERSION%" --name=cheq_rti_init    --type=none    --priority=10 --content="%SNIPPETS%\init-slim.vcl"
%FASTLY% vcl snippet create --service-id="%SERVICE_ID%" --version="%VERSION%" --name=cheq_rti_recv    --type=recv    --priority=10 --content="%SNIPPETS%\recv.vcl"
%FASTLY% vcl snippet create --service-id="%SERVICE_ID%" --version="%VERSION%" --name=cheq_rti_pass    --type=pass    --priority=10 --content="%SNIPPETS%\pass.vcl"
%FASTLY% vcl snippet create --service-id="%SERVICE_ID%" --version="%VERSION%" --name=cheq_rti_fetch   --type=fetch   --priority=10 --content="%SNIPPETS%\fetch.vcl"
%FASTLY% vcl snippet create --service-id="%SERVICE_ID%" --version="%VERSION%" --name=cheq_rti_deliver --type=deliver --priority=10 --content="%SNIPPETS%\deliver.vcl"
%FASTLY% vcl snippet create --service-id="%SERVICE_ID%" --version="%VERSION%" --name=cheq_rti_error   --type=error   --priority=10 --content="%SNIPPETS%\error.vcl"

%FASTLY% service-version activate --service-id="%SERVICE_ID%" --version="%VERSION%"
```

> Use `vcl snippet update` instead of `create` if the snippets already exist (409 Conflict error).

---

## Uploading via the Fastly Web UI

1. **Fastly Dashboard → Your Service → Edit Configuration** (clone a version first)
2. Left sidebar → **VCL Snippets** → **Create snippet**
3. For each snippet:

| Name               | Type      | Priority | Content file    |
|--------------------|-----------|----------|-----------------|
| `cheq_rti_init`    | `none`    | 10       | `init-slim.vcl` |
| `cheq_rti_recv`    | `recv`    | 10       | `recv.vcl`      |
| `cheq_rti_pass`    | `pass`    | 10       | `pass.vcl`      |
| `cheq_rti_fetch`   | `fetch`   | 10       | `fetch.vcl`     |
| `cheq_rti_deliver` | `deliver` | 10       | `deliver.vcl`   |
| `cheq_rti_error`   | `error`   | 10       | `error.vcl`     |

4. Paste the file contents, set Type and Priority, and save each one
5. Click **Activate**

> **Snippet type must be `none` for `cheq_rti_init`**. If it is wrong the subroutines won't be defined and every other snippet will fail with `Undefined function`.

---

## Updating snippets after code changes

```cmd
rem Regenerate init-slim.vcl after editing init.vcl
powershell -Command "(Get-Content '%SNIPPETS%\init.vcl') | Where-Object { $_ -notmatch '^\s*#' } | Set-Content '%SNIPPETS%\init-slim.vcl'"

rem Upload updated snippets
%FASTLY% vcl snippet update --service-id="%SERVICE_ID%" --version="%VERSION%" --name=cheq_rti_init    --content="%SNIPPETS%\init-slim.vcl"
%FASTLY% vcl snippet update --service-id="%SERVICE_ID%" --version="%VERSION%" --name=cheq_rti_recv    --content="%SNIPPETS%\recv.vcl"
%FASTLY% vcl snippet update --service-id="%SERVICE_ID%" --version="%VERSION%" --name=cheq_rti_pass    --content="%SNIPPETS%\pass.vcl"
%FASTLY% vcl snippet update --service-id="%SERVICE_ID%" --version="%VERSION%" --name=cheq_rti_fetch   --content="%SNIPPETS%\fetch.vcl"
%FASTLY% vcl snippet update --service-id="%SERVICE_ID%" --version="%VERSION%" --name=cheq_rti_deliver --content="%SNIPPETS%\deliver.vcl"
%FASTLY% vcl snippet update --service-id="%SERVICE_ID%" --version="%VERSION%" --name=cheq_rti_error   --content="%SNIPPETS%\error.vcl"

%FASTLY% service-version activate --service-id="%SERVICE_ID%" --version="%VERSION%"
```

---

## Removing the integration

```cmd
for %N in (cheq_rti_init cheq_rti_recv cheq_rti_pass cheq_rti_fetch cheq_rti_deliver cheq_rti_error) do (
  %FASTLY% vcl snippet delete --service-id="%SERVICE_ID%" --version="%VERSION%" --name=%N
)
```
