const {
    DeleteObjectCommand,
    GetObjectCommand,
    HeadObjectCommand,
    PutObjectCommand
} = require('@aws-sdk/client-s3');

function createR2Storage({ client, getSignedUrl, config }) {
    return {
        put: ({ key, body, contentType, contentLength }) => client.send(new PutObjectCommand({
            Bucket: config.bucketName,
            Key: key,
            Body: body,
            ContentType: contentType,
            ContentLength: contentLength
        })),
        remove: (key) => client.send(new DeleteObjectCommand({
            Bucket: config.bucketName,
            Key: key
        })),
        head: (key) => client.send(new HeadObjectCommand({
            Bucket: config.bucketName,
            Key: key
        })),
        read: (key, options = {}) => client.send(new GetObjectCommand({
            Bucket: config.bucketName,
            Key: key
        }), options),
        getSignedUrl: (key) => getSignedUrl(
            client,
            new GetObjectCommand({ Bucket: config.bucketName, Key: key }),
            { expiresIn: config.signedUrlTtlSeconds }
        )
    };
}

module.exports = { createR2Storage };
