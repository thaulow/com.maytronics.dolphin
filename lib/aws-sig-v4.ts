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

  // Build canonical query string (parameters must be sorted alphabetically)
  const queryParams: Record<string, string> = {
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
    'X-Amz-Credential': `${credentials.AccessKeyId}/${credentialScope}`,
    'X-Amz-Date': amzDate,
    'X-Amz-SignedHeaders': 'host',
  };

  if (credentials.Token) {
    queryParams['X-Amz-Security-Token'] = credentials.Token;
  }

  const sortedKeys = Object.keys(queryParams).sort();
  const canonicalQueryString = sortedKeys
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(queryParams[k])}`)
    .join('&');

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

  return `wss://${endpoint}/mqtt?${canonicalQueryString}&X-Amz-Signature=${signature}`;
}
