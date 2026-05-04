/**
 * Local test script for CloudFront Origin-Request Lambda
 * Tests the integration without requiring AWS SAM CLI
 * Run with: npx tsx test-sam-local-origin-request.ts
 * Or debug with the "Debug Origin-Request (Direct TS)" launch configuration
 */

import { handle } from './src/origin-request';
import event from './events/origin-request-event.json';

console.log('🚀 Testing CloudFront Origin-Request Lambda locally...\n');

handle(event as any)
    .then((result: any) => {
        console.log('✅ Lambda execution successful!\n');
        console.log('📊 Result:');
        console.log(JSON.stringify(result, null, 2));

        if (result.headers && result.headers['x-cheq-rti-result']) {
            console.log('\n✅ RTI header added to request:');
            console.log(result.headers['x-cheq-rti-result'][0].value);

            const rtiResult = result.headers['x-cheq-rti-result'][0].value;
            const verdict = rtiResult.match(/verdict=([^;]+)/)?.[1];
            const threatCode = rtiResult.match(/threat-type-code=([^;]+)/)?.[1];

            console.log('\n📋 RTI Analysis:');
            console.log(`   Verdict: ${verdict}`);
            console.log(`   Threat Code: ${threatCode}`);

            if (verdict === 'benign') {
                console.log('\n✅ Traffic is legitimate - would be forwarded to origin');
            } else {
                console.log('\n⚠️  Threat detected - origin should block this request');
            }
        }

        if (result.status && result.status !== '200') {
            console.log(`\n🛑 Request blocked with status: ${result.status}`);
        }
    })
    .catch((error: Error) => {
        console.error('❌ Lambda execution failed:\n');
        console.error(error);
        process.exit(1);
    });
