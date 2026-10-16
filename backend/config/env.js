function loadEnv(env = process.env) {
    // Temporary compatibility for existing local .env files; runtime code uses JWT_SECRET.
    if (!env.JWT_SECRET && env.JWT_Secret) {
        if (env.ALLOW_LEGACY_JWT_SECRET !== 'true') {
            throw new Error(
                'JWT_SECRET is required. Rename JWT_Secret to JWT_SECRET, or temporarily set ALLOW_LEGACY_JWT_SECRET=true during migration.'
            );
        }

        env.JWT_SECRET = env.JWT_Secret;
        process.emitWarning(
            'JWT_Secret is deprecated. Rename JWT_Secret to JWT_SECRET and remove ALLOW_LEGACY_JWT_SECRET=true.',
            'DeprecationWarning'
        );
    }

    const requiredVariables = ['DB_URL', 'JWT_SECRET', 'JWT_EXPIRY', 'FRONTEND_URL'];
    const missingVariables = requiredVariables.filter((name) => !env[name]);

    if (missingVariables.length > 0) {
        throw new Error(`Missing environment variables: ${missingVariables.join(', ')}`);
    }

    const tokenDurationValue = env.CLOUDINARY_AUTH_TOKEN_DURATION_SECONDS;
    const cloudinaryAuthTokenDurationSeconds = tokenDurationValue === undefined || tokenDurationValue === ''
        ? 600
        : Number(tokenDurationValue);

    if (!Number.isInteger(cloudinaryAuthTokenDurationSeconds)
        || cloudinaryAuthTokenDurationSeconds < 60
        || cloudinaryAuthTokenDurationSeconds > 3600) {
        throw new Error('CLOUDINARY_AUTH_TOKEN_DURATION_SECONDS must be an integer between 60 and 3600');
    }

    const r2Enabled = env.R2_ENABLED === 'true';
    let r2 = { enabled: false };

    if (r2Enabled) {
        const requiredR2Variables = ['R2_ACCOUNT_ID', 'R2_BUCKET_NAME', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY'];
        const missingR2Variables = requiredR2Variables.filter((name) => !env[name]);

        if (missingR2Variables.length > 0) {
            throw new Error(`Missing R2 environment variables: ${missingR2Variables.join(', ')}`);
        }

        if (!/^[a-f0-9]{32}$/i.test(env.R2_ACCOUNT_ID)) {
            throw new Error('R2_ACCOUNT_ID must be a 32-character hexadecimal Cloudflare account ID');
        }

        const signedUrlTtlValue = env.R2_SIGNED_URL_TTL_SECONDS;
        const signedUrlTtlSeconds = signedUrlTtlValue === undefined || signedUrlTtlValue === ''
            ? 600
            : Number(signedUrlTtlValue);

        if (!Number.isInteger(signedUrlTtlSeconds)
            || signedUrlTtlSeconds < 60
            || signedUrlTtlSeconds > 3600) {
            throw new Error('R2_SIGNED_URL_TTL_SECONDS must be an integer between 60 and 3600');
        }

        r2 = {
            enabled: true,
            accountId: env.R2_ACCOUNT_ID,
            bucketName: env.R2_BUCKET_NAME,
            accessKeyId: env.R2_ACCESS_KEY_ID,
            secretAccessKey: env.R2_SECRET_ACCESS_KEY,
            endpoint: env.R2_ENDPOINT || `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
            signedUrlTtlSeconds
        };
    }

    return {
        dbUrl: env.DB_URL,
        jwtSecret: env.JWT_SECRET,
        jwtExpiry: env.JWT_EXPIRY,
        frontendUrl: env.FRONTEND_URL,
        cloudinaryAuthTokenDurationSeconds,
        r2,
        nodeEnv: env.NODE_ENV || 'development'
    };
}

module.exports = { loadEnv };
