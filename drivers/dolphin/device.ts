'use strict';

import Homey from 'homey';
import { MaytronicsApi } from '../../lib/MaytronicsApi';
import { MaytronicsCloud } from '../../lib/MaytronicsCloud';
import {
  calculateState,
  CalculatedState,
  LED_MODES,
  LED_MODE_IDS,
  CREDENTIAL_REFRESH_INTERVAL,
  STATE_REFRESH_INTERVAL,
  RECONNECT_DELAY,
} from '../../lib/constants';
import type { AwsCredentials, DynamicMessage, LedState, ReportedState } from '../../lib/types';

class DolphinDevice extends Homey.Device {

  private api!: MaytronicsApi;
  private cloud!: MaytronicsCloud;
  private credentialRefreshTimer?: ReturnType<typeof setTimeout>;
  private stateRefreshTimer?: ReturnType<typeof setTimeout>;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private previousStatus: string = '';
  private currentLedState: LedState = { ledMode: 1, ledIntensity: 80, ledEnable: true };
  private awsCredentials?: AwsCredentials;

  async onInit() {
    this.api = new MaytronicsApi();
    this.cloud = new MaytronicsCloud();

    // Set up MQTT event handlers
    this.cloud.on('stateUpdate', this.onStateUpdate.bind(this));
    this.cloud.on('dynamicMessage', this.onDynamicMessage.bind(this));
    this.cloud.on('connected', () => {
      this.log('MQTT connected');
      this.setAvailable().catch(this.error);
      // Request initial state
      this.cloud.requestState();
    });
    this.cloud.on('disconnected', () => {
      this.log('MQTT disconnected');
      this.setUnavailable('Connection lost').catch(this.error);
      this.scheduleReconnect();
    });
    this.cloud.on('error', (err: Error) => {
      this.error('MQTT error:', err.message);
    });

    // Register capability listeners
    this.registerCapabilityListener('onoff', this.onCapabilityOnOff.bind(this));
    this.registerCapabilityListener('cleaning_mode', this.onCapabilityCleaningMode.bind(this));
    this.registerCapabilityListener('dim', this.onCapabilityDim.bind(this));
    this.registerCapabilityListener('led_mode', this.onCapabilityLedMode.bind(this));

    // Connect
    await this.connectToCloud();

    this.log('DolphinDevice has been initialized');
  }

  /**
   * Full authentication and MQTT connection flow.
   */
  private async connectToCloud(): Promise<void> {
    try {
      const settings = this.getSettings();
      const store = this.getStore();
      const { email, password } = settings;
      const { motorUnitSerial } = store;

      this.log(`Connecting: email=${email}, motorUnitSerial=${motorUnitSerial}`);

      if (!email || !password) {
        throw new Error('Missing email or password in device settings');
      }
      if (!motorUnitSerial) {
        throw new Error('Missing motorUnitSerial in device store');
      }

      // Authenticate with REST API
      this.log('Step 1: Logging in to Maytronics API...');
      await this.api.login(email, password);
      this.log('Step 1: Login successful');

      // Get AWS credentials
      this.log('Step 2: Getting AWS credentials...');
      this.awsCredentials = await this.api.getAwsCredentials(email, motorUnitSerial);
      this.log('Step 2: AWS credentials received');

      // Connect MQTT
      this.log('Step 3: Connecting MQTT...');
      await this.cloud.connect(motorUnitSerial, this.awsCredentials);
      this.log('Step 3: MQTT connected');

      // Request temperature if M700
      this.requestTemperatureIfSupported();

      // Schedule credential refresh (AWS tokens expire)
      this.scheduleCredentialRefresh();

      // Schedule periodic state refresh
      this.scheduleStateRefresh();
    } catch (err: any) {
      const message = err?.message || String(err);
      this.error('Failed to connect:', message);
      await this.setUnavailable(message).catch(this.error);
      this.scheduleReconnect();
    }
  }

  /**
   * Handle reported state updates from MQTT shadow.
   */
  private onStateUpdate(state: ReportedState, _version: number): void {
    // System state
    let calculatedStatus: string | undefined;
    if (state.systemState) {
      const { pwsState, robotState } = state.systemState;
      calculatedStatus = calculateState(pwsState, robotState);

      const isCleaning = calculatedStatus === CalculatedState.Cleaning || calculatedStatus === CalculatedState.Init;
      this.setCapabilityValue('onoff', isCleaning).catch(this.error);
      this.setCapabilityValue('robot_status', calculatedStatus).catch(this.error);

      // Cycle count (total power-on count)
      if (state.systemState.rTurnOnCount != null) {
        this.setCapabilityValue('cycle_count', state.systemState.rTurnOnCount).catch(this.error);
      }

      // Fire triggers on status change
      if (this.previousStatus !== calculatedStatus) {
        this.handleStatusChange(this.previousStatus, calculatedStatus, state);
        this.previousStatus = calculatedStatus;
      }
    }

    // Cleaning mode and cycle time remaining
    if (state.cycleInfo?.cleaningMode?.mode) {
      const { mode, cycleTime, cycleStartTimeUTC } = state.cycleInfo.cleaningMode;
      if (mode !== 'pickup') {
        this.setCapabilityValue('cleaning_mode', mode).catch(this.error);
      }

      // Calculate time remaining
      if (cycleTime && cycleStartTimeUTC) {
        const nowSeconds = Math.floor(Date.now() / 1000);
        const elapsedMinutes = Math.floor((nowSeconds - cycleStartTimeUTC) / 60);
        const remaining = Math.max(0, cycleTime - elapsedMinutes);
        this.setCapabilityValue('cycle_time_remaining', remaining).catch(this.error);
      } else if (calculatedStatus === CalculatedState.Off) {
        this.setCapabilityValue('cycle_time_remaining', 0).catch(this.error);
      }
    }

    // Filter bag
    if (state.filterBagIndication) {
      const filterValue = state.filterBagIndication.state;
      if (filterValue >= 0 && filterValue <= 100) {
        this.setCapabilityValue('filter_status', filterValue).catch(this.error);

        // Trigger filter bag full
        if (filterValue >= 100) {
          this.driver.ready().then(() => {
            (this.homey.flow.getDeviceTriggerCard('filter_bag_full') as any)
              .trigger(this)
              .catch(this.error);
          }).catch(this.error);
        }
      }
    }

    // WiFi signal and network name
    if (state.debug?.WIFI_RSSI != null) {
      this.setCapabilityValue('wifi_signal', state.debug.WIFI_RSSI).catch(this.error);
    }
    const netName = state.debug?.WIFI_NETName || state.wifi?.netName;
    if (netName) {
      this.setCapabilityValue('network_name', netName).catch(this.error);
    }

    // Robot errors
    if (state.robotError) {
      const { errorCode } = state.robotError;
      const errorStr = errorCode > 0 ? `Error ${errorCode}` : 'None';
      this.setCapabilityValue('robot_error', errorStr).catch(this.error);

      if (errorCode > 0) {
        this.driver.ready().then(() => {
          (this.homey.flow.getDeviceTriggerCard('robot_error_occurred') as any)
            .trigger(this, { error_code: errorCode })
            .catch(this.error);
        }).catch(this.error);
      }
    }

    // LED state
    if (state.led) {
      this.currentLedState = state.led;
      const ledModeStr = LED_MODES[state.led.ledMode] || 'blinking';
      this.setCapabilityValue('led_mode', ledModeStr).catch(this.error);
      this.setCapabilityValue('dim', state.led.ledIntensity / 100).catch(this.error);
    }
  }

  /**
   * Handle dynamic MQTT messages (temperature for M700).
   */
  private onDynamicMessage(message: DynamicMessage): void {
    // Temperature response
    if (message.type === 'iotResponse' && message.temperature != null) {
      this.setCapabilityValue('measure_temperature', message.temperature).catch(this.error);
    }
  }

  /**
   * Handle status transitions and fire appropriate triggers.
   */
  private handleStatusChange(previous: string, current: string, state: ReportedState): void {
    // Cleaning started
    if (current === CalculatedState.Cleaning && previous !== CalculatedState.Cleaning) {
      const mode = state.cycleInfo?.cleaningMode?.mode || 'all';
      this.driver.ready().then(() => {
        (this.homey.flow.getDeviceTriggerCard('cleaning_started') as any)
          .trigger(this, { mode })
          .catch(this.error);
      }).catch(this.error);
    }

    // Cleaning finished
    if (previous === CalculatedState.Cleaning && current !== CalculatedState.Cleaning) {
      this.driver.ready().then(() => {
        (this.homey.flow.getDeviceTriggerCard('cleaning_finished') as any)
          .trigger(this)
          .catch(this.error);
      }).catch(this.error);
    }
  }

  // --- Capability Listeners ---

  private async onCapabilityOnOff(value: boolean): Promise<void> {
    if (value) {
      const mode = this.getCapabilityValue('cleaning_mode') || 'all';
      await this.startCleaning(mode);
    } else {
      await this.stopCleaning();
    }
  }

  private async onCapabilityCleaningMode(value: string): Promise<void> {
    // If currently cleaning, switch to the new mode
    if (this.getCapabilityValue('onoff')) {
      await this.startCleaning(value);
    }
  }

  private async onCapabilityDim(value: number): Promise<void> {
    const intensity = Math.round(value * 100);
    this.cloud.sendCommand({
      led: {
        ledEnable: this.currentLedState.ledEnable,
        ledIntensity: intensity,
        ledMode: this.currentLedState.ledMode,
      },
    });
  }

  private async onCapabilityLedMode(value: string): Promise<void> {
    const modeId = LED_MODE_IDS[value] || 1;
    this.cloud.sendCommand({
      led: {
        ledEnable: true,
        ledIntensity: this.currentLedState.ledIntensity,
        ledMode: modeId,
      },
    });
  }

  // --- Public Command Methods (used by flow actions) ---

  async startCleaning(mode: string): Promise<void> {
    this.cloud.sendCommand({
      cleaningMode: { mode },
    });
  }

  async stopCleaning(): Promise<void> {
    this.cloud.sendCommand({
      systemState: { pwsState: 'off' },
    });
  }

  async returnToBase(): Promise<void> {
    this.cloud.sendCommand({
      cleaningMode: { mode: 'pickup' },
    });
  }

  async setLed(mode: string, brightness: number): Promise<void> {
    const modeId = LED_MODE_IDS[mode] || 1;
    this.cloud.sendCommand({
      led: {
        ledEnable: true,
        ledIntensity: brightness,
        ledMode: modeId,
      },
    });
  }

  // --- Scheduling ---

  private scheduleCredentialRefresh(): void {
    if (this.credentialRefreshTimer) {
      this.homey.clearTimeout(this.credentialRefreshTimer);
    }
    this.credentialRefreshTimer = this.homey.setTimeout(async () => {
      try {
        await this.refreshCredentials();
        this.scheduleCredentialRefresh();
      } catch (err) {
        this.error('Credential refresh failed:', err);
        this.scheduleReconnect();
      }
    }, CREDENTIAL_REFRESH_INTERVAL);
  }

  private scheduleStateRefresh(): void {
    if (this.stateRefreshTimer) {
      this.homey.clearTimeout(this.stateRefreshTimer);
    }
    this.stateRefreshTimer = this.homey.setTimeout(() => {
      if (this.cloud.connected) {
        this.cloud.requestState();
        this.requestTemperatureIfSupported();
      }
      this.scheduleStateRefresh();
    }, STATE_REFRESH_INTERVAL);
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) {
      this.homey.clearTimeout(this.reconnectTimer);
    }
    this.reconnectTimer = this.homey.setTimeout(async () => {
      this.log('Attempting reconnect...');
      await this.connectToCloud();
    }, RECONNECT_DELAY);
  }

  /**
   * Refresh AWS credentials and reconnect MQTT.
   */
  private async refreshCredentials(): Promise<void> {
    const { email } = this.getSettings();
    const { motorUnitSerial } = this.getStore();

    this.awsCredentials = await this.api.getAwsCredentials(email, motorUnitSerial);
    await this.cloud.connect(motorUnitSerial, this.awsCredentials);
    this.cloud.requestState();
    this.log('Credentials refreshed, MQTT reconnected');
  }

  /**
   * Request temperature reading if the robot family supports it.
   */
  private requestTemperatureIfSupported(): void {
    const { robotFamily, serialNumber } = this.getStore();
    if (robotFamily === 'M700') {
      this.cloud.requestTemperature(serialNumber);
    }
  }

  // --- Lifecycle ---

  async onSettings({
    newSettings,
    changedKeys,
  }: {
    oldSettings: Record<string, unknown>;
    newSettings: Record<string, unknown>;
    changedKeys: string[];
  }): Promise<string | void> {
    if (changedKeys.includes('email') || changedKeys.includes('password')) {
      // Re-authenticate with new credentials
      this.clearTimers();
      await this.cloud.disconnect();
      await this.connectToCloud();
    }
  }

  async onDeleted(): Promise<void> {
    this.clearTimers();
    await this.cloud.disconnect();
    this.log('DolphinDevice has been deleted');
  }

  async onUninit(): Promise<void> {
    this.clearTimers();
    await this.cloud.disconnect();
  }

  private clearTimers(): void {
    if (this.credentialRefreshTimer) {
      this.homey.clearTimeout(this.credentialRefreshTimer);
      this.credentialRefreshTimer = undefined;
    }
    if (this.stateRefreshTimer) {
      this.homey.clearTimeout(this.stateRefreshTimer);
      this.stateRefreshTimer = undefined;
    }
    if (this.reconnectTimer) {
      this.homey.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
  }
}

module.exports = DolphinDevice;
export default DolphinDevice;
