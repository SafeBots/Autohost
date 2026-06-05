// src/providers/cloudfront.js
//
// CloudFront SaaS Manager provider. When this provider is selected, the
// flow is:
//   1. User has already configured a CloudFront SaaS Manager distribution
//      pointing at this box's origin
//   2. For a new hostname, we tell CloudFront to add it as an alias to the
//      distribution and provision a managed cert for it via ACM
//   3. On the origin side, we use a Let's Encrypt cert (which CloudFront
//      will accept for origin SSL verification), so this provider
//      internally delegates to Let's Encrypt for the origin cert AND
//      registers the hostname with CloudFront for the browser-facing leg.
//
// This is more complex than the other providers because two things have
// to happen — CDN-side registration + origin-side cert — and they're
// independent failures. We do them in parallel.
//
// Required env vars:
//   AUTOVHOST_AWS_REGION                — e.g. 'us-east-1'
//   AUTOVHOST_AWS_ACCESS_KEY_ID         — IAM creds
//   AUTOVHOST_AWS_SECRET_ACCESS_KEY
//   AUTOVHOST_CLOUDFRONT_DISTRIBUTION_ID — the SaaS Manager distribution
//
// This provider currently delegates the origin cert work to the letsencrypt
// provider; CloudFront-side registration is a TODO since the AWS SDK is
// non-trivial without it as a dependency. For v1 of the open-source release,
// we expose this provider as "registers with Let's Encrypt for now; full
// CloudFront integration coming."

'use strict';

const letsencrypt = require('./letsencrypt');

function create(cfg) {
    const region = process.env.AUTOVHOST_AWS_REGION;
    const distributionId = process.env.AUTOVHOST_CLOUDFRONT_DISTRIBUTION_ID;

    if (!region || !distributionId) {
        throw new Error('cloudfront provider requires AUTOVHOST_AWS_REGION and AUTOVHOST_CLOUDFRONT_DISTRIBUTION_ID env vars');
    }

    // For now, delegate the cert provisioning to Let's Encrypt and emit a
    // warning that the CloudFront-side registration is not yet implemented.
    // Production users who need full SaaS Manager integration should
    // implement the AWS SDK call here (or use AWS CLI/SDK out-of-band).
    const inner = letsencrypt.create(cfg);

    async function provisionCert(host) {
        // Step 1: Let's Encrypt for the origin cert (CloudFront will accept this)
        const result = await inner.provisionCert(host);

        // Step 2: TODO — register the hostname with CloudFront SaaS Manager
        // distribution. Pseudo-code:
        //
        //   const sdk = require('@aws-sdk/client-cloudfront');
        //   const client = new sdk.CloudFrontClient({ region, credentials });
        //   await client.send(new sdk.UpdateDistributionCommand({
        //     Id: distributionId,
        //     ...modified config that adds the new alias...
        //   }));
        //
        // Implementation depends on whether the user has AWS SDK installed
        // and how they want to handle CloudFront credentials. For v1 of the
        // open-source release, we recommend handling this out-of-band:
        // either pre-register the hostnames you'll use, or have a separate
        // automation that watches autohost logs and calls CloudFront.

        process.stderr.write(JSON.stringify({
            level: 'warn',
            event: 'cloudfront_registration_skipped',
            host,
            message: 'origin cert provisioned via Let\'s Encrypt; CloudFront-side alias registration is not yet implemented in this provider — register the hostname manually or via a separate script',
            distributionId,
        }) + '\n');

        return result;
    }

    return {
        name: 'cloudfront',
        provisionCert,
        renewCert: provisionCert,
    };
}

module.exports = { create };
