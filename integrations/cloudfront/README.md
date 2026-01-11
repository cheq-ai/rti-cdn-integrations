<div align="center">
  <img src="https://raw.githubusercontent.com/cheq-ai/rti-cdn-integrations/main/assets/cheq-logo.svg">
</div>

# cheq-rti-cdn-integrations::cloudfront
![Integration Version](https://img.shields.io/github/v/release/cheq-ai/rti-cdn-integrations?label=Integration%20Version)
![Lambda Edge Runtime](https://img.shields.io/badge/Lambda%40Edge_Runtime-Node.js_18-44cc11)
![AWS SAM CLI](https://img.shields.io/badge/AWS_SAM_CLI-v1.95.0-44cc11)


This repository provides the components to invoke RTI from CloudFront.

The provided CloudFront Origin Request and Origin Response Lambda@Edge functions invoke RTI and set response cookie.

If you have an existing CloudFront distribution that uses caching we recommend that you create a second CloudFront distribution with caching disabled that invokes RTI and uses your existing distribution as the origin server.

### Documentation

[CloudFront Integration](https://github.com/cheq-ai/rti-cdn-integrations/blob/main/integrations/cloudfront/README.md)

Built
with [AWS SAM CLI](https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/using-sam-cli.html)

### Prerequisites:

Modify the [configuration](https://github.com/cheq-ai/rti-cdn-integrations/blob/main/integrations/cloudfront/src/config.ts)
at `src/config.ts` to set your `apiKey` and `tagHash`. The API key and tag hash are available in the Paradome platform under “Settings -> Defend” and "Settings -> TAGS".

### Verify config

```bash
cd lib
npm install
npm run test
```

### Test lambda locally

```bash
sam build
sam local invoke OriginRequest -e events/origin-request-event.json
sam local invoke OriginResponse -e events/origin-response-event.json
```

### Deploy, must always run `sam build` after making any changes

```bash
sam build
sam deploy --region us-east-1 # deploys the stack using the name defined in samconfig.toml
sam deploy --region us-east-1 --parameter-overrides TrustedIPHeader=bar # includes origin request policies with trusted ip header
```

### Output

```
CloudFormation outputs from deployed stack
-------------------------------------------------------------------------------------------------------------------------
Outputs
-------------------------------------------------------------------------------------------------------------------------
Key                 OriginRequestVersionARN
Description         Origin Request lambda version ARN.
Value               arn:aws:lambda:us-east-1:839097227002:function:cheq-rti-integration-cloudfront-origin-request:1

Key                 OriginRequestPolicyNoHost
Description         Includes RTI, ja3 fingerprint and tls headers, no host header
Value               cheq-rti-integration-cloudfront-origin-request-policy-no-host

Key                 OriginResponseVersionARN
Description         Origin Response lambda version ARN.
Value               arn:aws:lambda:us-east-1:839097227002:function:cheq-rti-integration-cloudfront-origin-response:1

Key                 OriginRequestPolicy
Description         Includes RTI, ja3 fingerprint, tls and host headers
Value               cheq-rti-integration-cloudfront-origin-request-policy

Key                 ViewerRequestARN
Description         Viewer Request CloudFront function ARN.
Value               arn:aws:cloudfront::839097227002:function/cheq-rti-integration-cloudfront-viewer-request

-------------------------------------------------------------------------------------------------------------------------
```

### CloudFront Distribution Configuration
- Use `OriginRequestVersionARN` for the CloudFront Origin Request Lambda@Edge
- Use `OriginResponseVersionARN` for the CloudFront Origin Response Lambda@Edge
- If your CloudFront origin expects the origin host and cannot resolve the distribution host:
  - Use the `ViewerRequestARN` for the CloudFront Viewer Request CloudFront Function to set the x-cheq-rti-host header
  - Use the `OriginRequestPolicyNoHost` for the CloudFront Origin Request Policy
- If your origin supports the distribution host:
  - Use the `OriginRequestPolicy` for the CloudFront Origin Request Policy


### Trusted IP Header
Pass the following to `sam deploy`

`--parameter-overrides TrustedIPHeader=foo`

```
Key                 OriginRequestPolicyNoHostTrustedIP
Description         Includes RTI, ja3 fingerprint, tls and trusted ip headers, no host header
Value               cheq-rti-integration-cloudfront-origin-request-policy-no-host-trusted-ip

Key                 OriginRequestPolicyTrustedIP
Description         Includes RTI, ja3 fingerprint, tls, host and trusted ip headers
Value               cheq-rti-integration-cloudfront-origin-request-policy-trusted-ip
```
- If your CloudFront origin expects the origin host and cannot resolve the distribution host:
  - Use the `OriginRequestPolicyNoHostTrustedIP` for the CloudFront Origin Request Policy
- If your origin supports the distribution host:
  - Use the `OriginRequestPolicyTrustedIP` for the CloudFront Origin Request Policy
