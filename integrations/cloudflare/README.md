<div align="center">
  <img src="https://raw.githubusercontent.com/cheq-ai/rti-cdn-integrations/main/assets/cheq-logo.svg">
</div>

# cheq-rti-cdn-integrations::cloudflare

![Integration Version](https://img.shields.io/github/v/release/cheq-ai/rti-cdn-integrations?label=Integration%20Version)
![Cloudflare Wrangler on npm](https://img.shields.io/npm/v/wrangler.svg?logo=npm&logoColor=fff&label=Cloudflare+Wrangler+on+npm&color=orange)

This repository provides the components to invoke RTI from Cloudflare.

### Documentation

[Cloudflare Integration](https://github.com/cheq-ai/rti-cdn-integrations/blob/main/integrations/cloudflare/README.md)

Built with [Cloudflare Wrangler](https://developers.cloudflare.com/workers/wrangler/)

### Prerequisites:

- You need Node.js v20+ (required by wrangler)

- Modify the [configuration](https://github.com/cheq-ai/rti-cdn-integrations/blob/main/integrations/cloudflare/src/config.ts)
at `src/config.ts` to set your `apiKey`, `tagHash` and the other settings of the integration.

### Login to Cloudflare (one-time)
```bash
npx wrangler login
```

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
Old Deployment ID: 2874786b-81d1-4f73-973e-8ec5a8305b6c
New 4.1 Deployment ID (Contains extra code to route to S3 static page and returns the rti header): a64c906d-cf25-4d32-8f7c-8fcd6c193b6f
```

### Cloudflare Configuration
Set up routes in `wrangler.toml` or using Cloudflare Dashboard

https://developers.cloudflare.com/workers/wrangler/configuration/

https://developers.cloudflare.com/workers/platform/triggers/routes/
