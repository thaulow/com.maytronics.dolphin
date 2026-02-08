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

export class MaytronicsCloud extends EventEmitter {

  private client: MqttClient | null = null;
  private motorUnitSerial: string = '';
  private _connected: boolean = false;

  /**
   * Connect to AWS IoT Core via MQTT over WebSocket.
   */
  async connect(motorUnitSerial: string, credentials: AwsCredentials): Promise<void> {
    this.motorUnitSerial = motorUnitSerial;

    // Disconnect existing connection if any
    await this.disconnect();

    const url = signWebSocketUrl(AWS_IOT_ENDPOINT, AWS_REGION, credentials);
    const clientId = `homey_dolphin_${motorUnitSerial}_${Date.now()}`;

    return new Promise((resolve, reject) => {
      this.client = mqtt.connect(url, {
        clientId,
        protocolVersion: 4,
        clean: false,
        keepalive: 30,
        reconnectPeriod: 0, // We handle reconnection ourselves
        connectTimeout: 30000,
      });

      const onFirstError = (err: Error) => {
        this.client!.removeListener('connect', onConnect);
        reject(err);
      };

      const onConnect = () => {
        this._connected = true;
        this.client!.removeListener('error', onFirstError);
        this.subscribeToTopics();
        this.emit('connected');
        resolve();
      };

      this.client.once('connect', onConnect);
      this.client.once('error', onFirstError);

      this.client.on('message', this.handleMessage.bind(this));

      this.client.on('close', () => {
        if (this._connected) {
          this._connected = false;
          this.emit('disconnected');
        }
      });

      this.client.on('error', (err: Error) => {
        this.emit('error', err);
      });
    });
  }

  /**
   * Subscribe to shadow and dynamic topics.
   */
  private subscribeToTopics(): void {
    if (!this.client || !this._connected) return;

    const shadowTopic = getShadowWildcardTopic(this.motorUnitSerial);
    const dynamicTopic = getDynamicTopic(this.motorUnitSerial);

    this.client.subscribe([shadowTopic, dynamicTopic], { qos: 0 }, (err) => {
      if (err) {
        this.emit('error', new Error(`Subscribe failed: ${err.message}`));
      }
    });
  }

  /**
   * Handle incoming MQTT messages.
   */
  private handleMessage(topic: string, payload: Buffer): void {
    try {
      const data = JSON.parse(payload.toString());

      // Shadow get/update accepted
      if (topic.includes('/shadow/get/accepted') || topic.includes('/shadow/update/accepted')) {
        const shadow = data as DeviceShadow;
        if (shadow.state?.reported) {
          this.emit('stateUpdate', shadow.state.reported, shadow.version || 0);
        }
        return;
      }

      // Shadow rejected
      if (topic.includes('/shadow/') && topic.includes('/rejected')) {
        this.emit('error', new Error(`Shadow rejected: ${JSON.stringify(data)}`));
        return;
      }

      // Dynamic topic (temperature, joystick responses)
      if (topic.includes('Maytronics/') && topic.endsWith('/main')) {
        this.emit('dynamicMessage', data as DynamicMessage);
        return;
      }
    } catch (err) {
      this.emit('error', new Error(`Failed to parse MQTT message on ${topic}: ${err}`));
    }
  }

  /**
   * Request the current device shadow state.
   */
  requestState(): void {
    if (!this.client || !this._connected) return;
    this.client.publish(getShadowGetTopic(this.motorUnitSerial), '{}', { qos: 0 });
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
    this.client.publish(getShadowUpdateTopic(this.motorUnitSerial), payload, { qos: 0 });
  }

  /**
   * Send a message to the dynamic topic (e.g., temperature request).
   */
  sendDynamic(payload: Record<string, unknown>): void {
    if (!this.client || !this._connected) return;
    this.client.publish(getDynamicTopic(this.motorUnitSerial), JSON.stringify(payload), { qos: 0 });
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
    this._connected = false;
    await new Promise<void>((resolve) => {
      this.client!.end(true, {}, () => {
        this.client = null;
        resolve();
      });
    });
  }
}
