/// <reference types="@fastly/js-compute" />
//
// CHEQ RTI – Fastly Compute@Edge translation layer
//
// Purpose
// -------
// Fastly VCL cannot set a custom backend request body (bereq.body does not
// exist). This Compute@Edge service bridges that gap:
//
//   VCL service (restart 0)
//     → sets X-CHEQ-Param-* request headers
//     → routes request to this Compute@Edge service as a backend
//
//   This service
//     → reads X-CHEQ-Param-* headers
//     → builds the RTI JSON payload
//     → POSTs to the RTI backend (obs.dev.cheqzone.com or rti-global.cheqzone.com)
//     → reads decision.verdict / classification.code / metadata.version from the JSON body
//     → returns them as X-Cheq-Verdict / X-Cheq-TT-Code / X-Cheq-Version response headers
//
//   VCL service (cheq_rti_backend_response)
//     → reads verdict headers from this service's response
//     → sets action (allow / block / redirect) for restart 1
//
// RTI host / all handler logic lives in handler.js.
// Tests import handler.js directly.
//

const { handleRequest } = require("./handler");

addEventListener("fetch", (event) => {
  event.respondWith(handleRequest(event.request));
});
