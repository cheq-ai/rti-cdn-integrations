import { CloudFrontRequestEvent, CloudFrontRequestResult } from 'aws-lambda';
import { handle as HandleHelper, RequestType } from './request-helper';

export const handle = async (event: CloudFrontRequestEvent): Promise<CloudFrontRequestResult> => {
    // IMPORTANT Note:
    // In a viewer-request trigger, ALL viewer headers are available — no origin request policy whitelisting required.
    // CloudFront-injected headers (cloudfront-viewer-tls, cloudfront-viewer-ja3-fingerprint, etc.) 
    // are not available in viewer request, but are available in origin request.
    return HandleHelper(event, RequestType.VIEWER_REQUEST);
};
