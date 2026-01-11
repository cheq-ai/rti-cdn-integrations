import { CloudFrontResponseEvent, CloudFrontResponseResult } from 'aws-lambda';
import { CloudFrontHeaders } from 'aws-lambda/common/cloudfront';

export const handle = async (event: CloudFrontResponseEvent): Promise<CloudFrontResponseResult> => {
    const cf = event.Records[0].cf;
    const cfResponse = cf.response;
    const cfRequest = cf.request;
    if (cfRequest.headers['x-cheq-rti-set-cookie']) {
        addHeader(cfResponse.headers, 'set-cookie', cfRequest.headers['x-cheq-rti-set-cookie'][0].value);
    }
    return cfResponse;
};

function addHeader(headers: CloudFrontHeaders, key: string, value: string): void {
    let existing = headers[key];
    if (!existing) {
        existing = [];
    }
    existing.push({ key, value });
    headers[key] = existing;
}
