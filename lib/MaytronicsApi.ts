'use strict';

import crypto from 'crypto';
import https from 'https';
import { API_BASE_URL, API_HEADERS } from './constants';
import type { ApiResponse, AwsCredentials, LoginData, RobotDetails } from './types';

export class MaytronicsApi {

  private token: string = '';

  /**
   * Make a POST request to the Maytronics API.
   */
  private async post<T>(path: string, body: string, extraHeaders?: Record<string, string>): Promise<ApiResponse<T>> {
    const url = `${API_BASE_URL}${path}`;
    const bodyBuffer = Buffer.from(body, 'utf8');
    const headers: Record<string, string> = {
      ...API_HEADERS,
      ...extraHeaders,
      'Content-Length': String(bodyBuffer.length),
    };

    return new Promise((resolve, reject) => {
      const req = https.request(url, { method: 'POST', headers }, (res) => {
        let data = '';
        res.on('data', (chunk: Buffer) => {
          data += chunk.toString();
        });
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data) as ApiResponse<T>;
            if (parsed.Status !== '1') {
              reject(new Error(`API error on ${path}: status=${parsed.Status}, body=${data}`));
              return;
            }
            resolve(parsed);
          } catch (err) {
            reject(new Error(`Failed to parse API response from ${path}: ${data}`));
          }
        });
      });
      req.on('error', reject);
      req.end(bodyBuffer);
    });
  }

  /**
   * Validate that an email is registered with Maytronics.
   */
  async validateEmail(email: string): Promise<boolean> {
    const res = await this.post<{ isEmailExists: boolean }>(
      '/users/isEmailExists/',
      `Email=${String(email)}`,
    );
    return res.Data.isEmailExists;
  }

  /**
   * Login with email and password.
   * Returns the API token and robot serial number.
   */
  async login(email: string, password: string): Promise<LoginData> {
    const res = await this.post<LoginData>(
      '/users/Login/',
      `Email=${String(email)}&Password=${String(password)}`,
    );
    this.token = res.Data.token;
    return res.Data;
  }

  /**
   * Get robot details by robot serial number.
   * Returns the motor unit serial (eSERNUM), robot family, name, etc.
   */
  async getRobotDetails(serialNumber: string): Promise<RobotDetails> {
    const res = await this.post<RobotDetails>(
      '/serialnumbers/getrobotdetailsbyrobotsn/',
      `Sernum=${String(serialNumber)}`,
      { token: this.token },
    );
    return res.Data;
  }

  /**
   * Get robot details by motor unit serial number (for periodic refresh).
   */
  async getRobotDetailsByMotorUnit(motorUnitSerial: string): Promise<RobotDetails> {
    const res = await this.post<RobotDetails>(
      '/serialnumbers/getrobotdetailsbymusn/',
      `Sernum=${String(motorUnitSerial)}`,
      { token: this.token },
    );
    return res.Data;
  }

  /**
   * Encrypt the motor unit serial using AES-128-CBC.
   * Key is derived from the first 2 characters of the email + "ha", hashed with MD5.
   * Retries until the base64 result contains no '+' (avoids URL encoding issues).
   */
  private encryptMotorUnitSerial(email: string, motorUnitSerial: string): string {
    const passwordStr = `${email.slice(0, 2)}ha`.toLowerCase();
    const key = crypto.createHash('md5').update(passwordStr).digest();

    // Retry with new random IV until result has no '+' (which would be
    // decoded as a space in application/x-www-form-urlencoded bodies)
    for (let i = 0; i < 20; i++) {
      const iv = crypto.randomBytes(16);
      const cipher = crypto.createCipheriv('aes-128-cbc', key, iv);
      const encrypted = Buffer.concat([
        cipher.update(motorUnitSerial, 'utf8'),
        cipher.final(),
      ]);
      const result = Buffer.concat([iv, encrypted]).toString('base64');
      if (!result.includes('+')) {
        return result;
      }
    }
    // Fallback: URL-encode the + characters
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-128-cbc', key, iv);
    const encrypted = Buffer.concat([
      cipher.update(motorUnitSerial, 'utf8'),
      cipher.final(),
    ]);
    return Buffer.concat([iv, encrypted]).toString('base64').replace(/\+/g, '%2B');
  }

  /**
   * Get temporary AWS IoT credentials.
   * Encrypts the motor unit serial and exchanges it for AWS credentials.
   */
  async getAwsCredentials(email: string, motorUnitSerial: string): Promise<AwsCredentials> {
    const encryptedSerial = this.encryptMotorUnitSerial(email, motorUnitSerial);
    const res = await this.post<AwsCredentials>(
      '/IOT/getToken_DecryptSN/',
      `Sernum=${String(encryptedSerial)}`,
      { token: this.token },
    );
    return res.Data;
  }

  /**
   * Get the current API token.
   */
  getToken(): string {
    return this.token;
  }

  /**
   * Set the API token (for restoring from stored credentials).
   */
  setToken(token: string): void {
    this.token = token;
  }
}
