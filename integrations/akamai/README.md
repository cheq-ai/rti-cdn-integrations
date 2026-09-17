<!-- cspell:ignore PMUSER CHEQ cheq cheqzone edgeservices recaptcha -->
<div align="center">
  <img src="https://raw.githubusercontent.com/cheq-ai/rti-cdn-integrations/main/assets/cheq-logo.svg">
</div>

# CHEQ RTI — Akamai EdgeWorker Integration

![Integration Version](https://img.shields.io/github/v/release/cheq-ai/rti-cdn-integrations?label=Integration%20Version)
![EdgeWorkers Runtime](https://img.shields.io/badge/Akamai_EdgeWorkers-JavaScript-44cc11)
![Build Runtime](https://img.shields.io/badge/Build-Node.js_22-44cc11)

---

This EdgeWorker integrates CHEQ Real-Time Interception (RTI, Agent Intent V4.1) into Akamai's
edge network to protect websites from bots, scrapers, and other invalid traffic.

## Which document do you want?

| You are… | Read |
|---|---|
| **Deploying or configuring this** on an Akamai property | **[DEPLOYMENT-GUIDE.md](DEPLOYMENT-GUIDE.md)** — install, Property Manager rules, every `PMUSER_*` variable, CAPTCHA setup, the action matrix, troubleshooting and a go-live checklist |
| **Changing the code** | **[DEV-README.md](DEV-README.md)** — architecture, request lifecycle, build & package, Akamai runtime constraints, the test harness |

## How it works

1. Every request passes through `onClientRequest` before reaching origin
2. The EdgeWorker calls the RTI API (`/defend/4.1/traffic`) via a same-property self-proxy
   (`/defend/*` Property Manager rule → `rti-global.cheqzone.com`)
3. Based on the verdict and the configured action matrix, the request is **allowed** (tagged
   with `x-cheq-rti-result` for origin/AAP), **blocked** (403 / stealth 404), **redirected**
   (302), or **challenged** (Google reCAPTCHA v2/v3 or the CHEQ browser interstitial)
4. **Fail-open by design** — on any error, traffic passes to origin untouched

Configuration is entirely console-side: set `PMUSER_CHEQ_USE_DYNAMIC_CONFIG=true` and the
EdgeWorker reads its whole configuration from Property Manager variables, so mode, thresholds
and paths change without a rebuild. No credentials ship in this package.

## Before you start

> ⚠️ **If you plan to use CAPTCHA, start this now — it has lead time.** The property needs an
> **Advanced behavior** carrying `<edgeservices:cookie.pass-set-cookie-policy>`. Without it
> Akamai silently strips the challenge session cookie, so a passed challenge never sticks and
> every page view is challenged again. Advanced behaviors are usually restricted to Akamai
> Professional Services, so it is a support request, not a checkbox. Details in
> [DEPLOYMENT-GUIDE.md](DEPLOYMENT-GUIDE.md) section 3.
