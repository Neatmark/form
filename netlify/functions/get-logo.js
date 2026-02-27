/**
 * get-logo.js
 * ───────────
 * Thin wrapper — delegates to get-photo.js using the 'logos' bucket.
 * get-photo.js already supports the 'logos' bucket via its ALLOWED_BUCKETS set.
 *
 * Usage: GET /.netlify/functions/get-logo?ref=<logoRef>
 */

const { handler: getPhotoHandler } = require('./get-photo');

exports.handler = async (event, context) => {
  const params = event.queryStringParameters || {};
  const ref    = String(params.ref || '').trim();

  // Inject bucket=logos into the query params and forward to get-photo
  const proxiedEvent = {
    ...event,
    queryStringParameters: { ...params, bucket: 'logos', ref }
  };

  return getPhotoHandler(proxiedEvent, context);
};
