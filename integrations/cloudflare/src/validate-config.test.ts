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
    });
});
