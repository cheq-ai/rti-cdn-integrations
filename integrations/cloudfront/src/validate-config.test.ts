import { RTIHelperService } from '../../core/services/rti-helper.service';
import { config } from './config';
import { describe, it } from 'vitest';

describe('Validate config', function () {
    it('verifies config is valid', () => {
        const rtiHelper = new RTIHelperService(config);
        const errors = rtiHelper.validateConfig();
        if (errors.length !== 0) {
            throw new Error(`invalid config: ${JSON.stringify(errors)}`);
        }

        if (!config.keepHeadersNames) {
            throw new Error(`keepHeadersNames is required and may be empty for all headers to be kept, or specifying the wanted headers to be kept, but cannot be null or undefined`);
        }   
    });
});
