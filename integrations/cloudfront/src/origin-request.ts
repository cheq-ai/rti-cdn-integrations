import { CloudFrontRequestEvent, CloudFrontRequestResult } from 'aws-lambda';
import { handle as HandleHelper, RequestType } from './request-helper';

export const handle = async (event: CloudFrontRequestEvent): Promise<CloudFrontRequestResult> => {
    // IMPORTANT Note:
    // In origin request trigger, we may control header availability with an origin request policy.
    return HandleHelper(event, RequestType.ORIGIN_REQUEST);
};
