import { RTIHelperService } from '../../core/services/rti-helper.service';
import { config } from './config';
import { describe, it } from 'vitest';

describe('Validate config', function () {
    it('verifies config is valid', () => {
        // Arrange
        const rtiHelper = new RTIHelperService(config);

        // Act
        const errors = rtiHelper.validateConfig();

        // Assert
        if (errors.length !== 0) {
            throw new Error(`invalid config: ${JSON.stringify(errors)}`);
        }
    });
});
