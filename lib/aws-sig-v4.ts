'use strict';

import crypto from 'crypto';
import type { AwsCredentials } from './types';

function hmac(key: Buffer | string, data: string): Buffer {
  return crypto.createHmac('sha256', key).update(data).digest();
}

function sha256(data: string): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

/**
 * Signs an AWS IoT WebSocket URL using SigV4.
 * Returns a wss:// URL that can be used with an MQTT client.
 *
 * IMPORTANT: X-Amz-Security-Token must NOT be in the canonical query string
 * for signing — it is appended AFTER the signature (per AWS IoT SDK v1).
 */
export function signWebSocketUrl(
  endpoint: string,
  region: string,
  credentials: AwsCredentials,
): string {
  const now = new Date();
  const dateStamp = now.toISOString().replace(/[:-]|\.\d{3}/g, '').slice(0, 8);
  const amzDate = `${now.toISOString().replace(/[:-]|\.\d{3}/g, '').slice(0, 15)}Z`;

  const service = 'iotdevicegateway';
  const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;

  // Build canonical query string — only signing parameters (NOT security token)
  const canonicalQueryString = [
    `X-Amz-Algorithm=AWS4-HMAC-SHA256`,
    `X-Amz-Credential=${encodeURIComponent(`${credentials.AccessKeyId}/${credentialScope}`)}`,
    `X-Amz-Date=${amzDate}`,
    `X-Amz-SignedHeaders=host`,
  ].join('&');

  // Canonical request
  const canonicalRequest = [
    'GET',
    '/mqtt',
    canonicalQueryString,
    `host:${endpoint}`,
    '',
    'host',
    sha256(''),
  ].join('\n');

  // String to sign
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    credentialScope,
    sha256(canonicalRequest),
  ].join('\n');

  // Derive signing key
  const kDate = hmac(`AWS4${credentials.SecretAccessKey}`, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  const kSigning = hmac(kService, 'aws4_request');

  // Calculate signature
  const signature = crypto
    .createHmac('sha256', kSigning)
    .update(stringToSign)
    .digest('hex');

  // Build final URL — security token added AFTER signature
  let url = `wss://${endpoint}/mqtt?${canonicalQueryString}&X-Amz-Signature=${signature}`;
  if (credentials.Token) {
    url += `&X-Amz-Security-Token=${encodeURIComponent(credentials.Token)}`;
  }
  return url;
}
