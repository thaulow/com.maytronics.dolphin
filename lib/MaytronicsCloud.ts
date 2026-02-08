'use strict';

import { EventEmitter } from 'events';
import mqtt from 'mqtt';
import type { MqttClient } from 'mqtt';
import { signWebSocketUrl } from './aws-sig-v4';
import {
  AWS_IOT_ENDPOINT,
  AWS_REGION,
  getShadowGetTopic,
  getShadowUpdateTopic,
  getShadowWildcardTopic,
  getDynamicTopic,
} from './constants';
import type { AwsCredentials, DeviceShadow, DynamicMessage, ReportedState } from './types';

export interface MaytronicsCloudEvents {
  stateUpdate: (state: ReportedState, version: number) => void;
  dynamicMessage: (message: DynamicMessage) => void;
  connected: () => void;
  disconnected: () => void;
  error: (error: Error) => void;
}

type LogFunction = (...args: any[]) => void;

export class MaytronicsCloud extends EventEmitter {

  private client: MqttClient | null = null;
  private motorUnitSerial: string = '';
  private _connected: boolean = false;
  private log: LogFunction = () => {};
  private logError: LogFunction = () => {};

  /**
   * Set logger functions so we can see what's happening.
   */
  setLogger(log: LogFunction, logError?: LogFunction): void {
    this.log = log;
    this.logError = logError || log;
  }

  /**
   * Connect to AWS IoT Core via MQTT over WebSocket.
   */
  async connect(motorUnitSerial: string, credentials: AwsCredentials): Promise<void> {
    this.motorUnitSerial = motorUnitSerial;

    // Log credential field names (not values) for debugging
    this.log('[MQTT] Credentials check:', {
      hasAccessKeyId: !!credentials.AccessKeyId,
      hasSecretAccessKey: !!credentials.SecretAccessKey,
      hasToken: !!credentials.Token,
      accessKeyIdLength: credentials.AccessKeyId?.length || 0,
      tokenLength: credentials.Token?.length || 0,
    });

    // Disconnect existing connection if any
    await this.disconnect();

    const url = signWebSocketUrl(AWS_IOT_ENDPOINT, AWS_REGION, credentials);
    const clientId = `homey_dolphin_${motorUnitSerial}_${Date.now()}`;

    this.log(`[MQTT] Connecting to ${AWS_IOT_ENDPOINT} with clientId=${clientId}`);
    this.log(`[MQTT] Signed URL length: ${url.length}`);

    return new Promise((resolve, reject) => {
      // Safety timeout — if neither 'connect' nor 'error' fires within 30s
      const connectTimeout = setTimeout(() => {
        this.logError('[MQTT] Connection timeout after 30s — no connect or error event');
        cleanup();
        if (this.client) {
          this.client.end(true);
          this.client = null;
        }
        reject(new Error('MQTT connection timed out after 30 seconds'));
      }, 30000);

      const cleanup = () => {
        clearTimeout(connectTimeout);
      };

      this.client = mqtt.connect(url, {
        clientId,
        protocolVersion: 4,
        clean: true,
        keepalive: 30,
        reconnectPeriod: 0,
        connectTimeout: 30000,
      });

      const onFirstError = (err: Error) => {
        this.logError('[MQTT] First connection error:', err.message);
        cleanup();
        this.client!.removeListener('connect', onConnect);
        reject(err);
      };

      const onConnect = async () => {
        this.log('[MQTT] Connected successfully');
        cleanup();
        this._connected = true;
        this.client!.removeListener('error', onFirstError);
        await this.subscribeToTopics();
        this.emit('connected');
        resolve();
      };

      this.client.once('connect', onConnect);
      this.client.once('error', onFirstError);

      this.client.on('message', this.handleMessage.bind(this));

      this.client.on('close', () => {
        this.log('[MQTT] Connection closed');
        if (this._connected) {
          this._connected = false;
          this.emit('disconnected');
        }
      });

      this.client.on('offline', () => {
        this.log('[MQTT] Client went offline');
      });

      this.client.on('error', (err: Error) => {
        this.logError('[MQTT] Error:', err.message);
        this.emit('error', err);
      });
    });
  }

  /**
   * Subscribe to shadow and dynamic topics.
   */
  private subscribeToTopics(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.client || !this._connected) {
        resolve();
        return;
      }

      const shadowTopic = getShadowWildcardTopic(this.motorUnitSerial);
      const dynamicTopic = getDynamicTopic(this.motorUnitSerial);

      this.log(`[MQTT] Subscribing to: ${shadowTopic}`);
      this.log(`[MQTT] Subscribing to: ${dynamicTopic}`);

      this.client.subscribe([shadowTopic, dynamicTopic], { qos: 0 }, (err, granted) => {
        if (err) {
          this.logError('[MQTT] Subscribe failed:', err.message);
          this.emit('error', new Error(`Subscribe failed: ${err.message}`));
          reject(err);
        } else {
          this.log('[MQTT] Subscribe result:', JSON.stringify(granted));
          resolve();
        }
      });
    });
  }

  /**
   * Handle incoming MQTT messages.
   */
  private handleMessage(topic: string, payload: Buffer): void {
    const payloadStr = payload.toString();
    this.log(`[MQTT] Message on topic: ${topic} (${payloadStr.length} bytes)`);

    try {
      const data = JSON.parse(payloadStr);

      // Shadow get/update accepted
      if (topic.includes('/shadow/get/accepted') || topic.includes('/shadow/update/accepted')) {
        const shadow = data as DeviceShadow;
        if (shadow.state?.reported) {
          const keys = Object.keys(shadow.state.reported);
          this.log(`[MQTT] State update received, keys: ${keys.join(', ')}, version: ${shadow.version}`);
          this.emit('stateUpdate', shadow.state.reported, shadow.version || 0);
        } else {
          this.log('[MQTT] Shadow accepted but no reported state');
        }
        return;
      }

      // Shadow rejected
      if (topic.includes('/shadow/') && topic.includes('/rejected')) {
        this.logError(`[MQTT] Shadow rejected: ${payloadStr.substring(0, 200)}`);
        this.emit('error', new Error(`Shadow rejected: ${JSON.stringify(data)}`));
        return;
      }

      // Dynamic topic (temperature, joystick responses)
      if (topic.includes('Maytronics/') && topic.endsWith('/main')) {
        this.log(`[MQTT] Dynamic message: ${payloadStr.substring(0, 200)}`);
        this.emit('dynamicMessage', data as DynamicMessage);
        return;
      }

      this.log(`[MQTT] Unhandled topic: ${topic}`);
    } catch (err) {
      this.logError(`[MQTT] Failed to parse message on ${topic}: ${err}`);
      this.emit('error', new Error(`Failed to parse MQTT message on ${topic}: ${err}`));
    }
  }

  /**
   * Request the current device shadow state.
   */
  requestState(): void {
    if (!this.client || !this._connected) {
      this.log('[MQTT] requestState: not connected, skipping');
      return;
    }
    const topic = getShadowGetTopic(this.motorUnitSerial);
    this.log(`[MQTT] Publishing state request to: ${topic}`);
    this.client.publish(topic, '{}', { qos: 0 });
  }

  /**
   * Send a desired state command via the device shadow.
   */
  sendCommand(desired: Record<string, unknown>): void {
    if (!this.client || !this._connected) {
      this.emit('error', new Error('Cannot send command: not connected'));
      return;
    }
    const payload = JSON.stringify({ state: { desired } });
    const topic = getShadowUpdateTopic(this.motorUnitSerial);
    this.log(`[MQTT] Sending command to ${topic}: ${payload.substring(0, 200)}`);
    this.client.publish(topic, payload, { qos: 0 });
  }

  /**
   * Send a message to the dynamic topic (e.g., temperature request).
   */
  sendDynamic(payload: Record<string, unknown>): void {
    if (!this.client || !this._connected) return;
    const topic = getDynamicTopic(this.motorUnitSerial);
    this.log(`[MQTT] Sending dynamic to ${topic}: ${JSON.stringify(payload).substring(0, 200)}`);
    this.client.publish(topic, JSON.stringify(payload), { qos: 0 });
  }

  /**
   * Request water temperature (M700 family only).
   */
  requestTemperature(serialNumber: string): void {
    this.sendDynamic({
      type: 'pwsRequest',
      description: 'temperature',
      robotSerial: serialNumber,
      msmu: this.motorUnitSerial,
    });
  }

  /**
   * Send a joystick navigation command (forward, backward, left, right, stop).
   */
  sendJoystick(direction: string): void {
    const speed = direction === 'stop' ? 0 : 100;
    this.sendDynamic({
      type: 'pwsRequest',
      description: 'joystick',
      content: {
        speed,
        direction,
      },
    });
  }

  /**
   * Exit joystick / remote-control mode.
   */
  exitJoystickMode(): void {
    this.sendDynamic({
      type: 'pwsRequest',
      description: 'joystick',
      content: {
        rcMode: 'exit',
      },
    });
  }

  /**
   * Check if connected.
   */
  get connected(): boolean {
    return this._connected;
  }

  /**
   * Disconnect and clean up.
   */
  async disconnect(): Promise<void> {
    if (!this.client) {
      return;
    }
    this.log('[MQTT] Disconnecting...');
    this._connected = false;
    await new Promise<void>((resolve) => {
      this.client!.end(true, {}, () => {
        this.client = null;
        resolve();
      });
    });
  }
}
