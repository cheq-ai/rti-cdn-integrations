<div align="center">
  <img src="https://raw.githubusercontent.com/cheq-ai/rti-cdn-integrations/main/assets/cheq-logo.svg">
</div>

# cheq-rti-cdn-integrations::cloudflare

![Integration Version](https://img.shields.io/github/v/release/cheq-ai/rti-cdn-integrations?label=Integration%20Version)
![Cloudflare Wrangler](https://img.shields.io/badge/Cloudflare_Wrangler-3.6.0-44cc11)

This repository provides the components to invoke RTI from Cloudflare.

### Documentation

[Cloudflare Integration](https://github.com/cheq-ai/rti-cdn-integrations/blob/main/integrations/cloudflare/README.md)

Built with [Cloudflare Wrangler](https://developers.cloudflare.com/workers/wrangler/)

### Prerequisites:

Modify the [configuration](https://github.com/cheq-ai/rti-cdn-integrations/blob/main/integrations/cloudflare/src/config.ts)
at `src/config.ts` to set your `apiKey`, `tagHash` and the other settings of the integration.

### Verify config

```bash
npm i; npm run test
```

### Test locally (using Wrangler)
```bash
npm i; npm run start
```

### Deploy (using Wrangler)
```bash
npm i; npm run deploy
```

### Example Deploy Output
```
Current Deployment ID: 2874786b-81d1-4f73-973e-8ec5a8305b6c
```

### Cloudflare Configuration
Set up routes in `wrangler.toml` or using Cloudflare Dashboard

https://developers.cloudflare.com/workers/wrangler/configuration/

https://developers.cloudflare.com/workers/platform/triggers/routes/
