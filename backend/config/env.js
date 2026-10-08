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

    return {
        dbUrl: env.DB_URL,
        jwtSecret: env.JWT_SECRET,
        jwtExpiry: env.JWT_EXPIRY,
        frontendUrl: env.FRONTEND_URL,
        nodeEnv: env.NODE_ENV || 'development'
    };
}

module.exports = { loadEnv };
