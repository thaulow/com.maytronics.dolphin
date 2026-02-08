'use strict';

// --- Maytronics REST API ---

export const API_BASE_URL = 'https://mbapp18.maytronics.com/api';

export const API_HEADERS: Record<string, string> = {
  appkey: '346BDE92-53D1-4829-8A2E-B496014B586C',
  'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8',
  'integration-version': '1.0.19',
  'User-Agent': 'HA-MyDolphin-Plus/1.0.25',
};

// --- AWS IoT ---

export const AWS_IOT_ENDPOINT = 'a12rqfdx55bdbv-ats.iot.eu-west-1.amazonaws.com';
export const AWS_REGION = 'eu-west-1';
export const AWS_IOT_PORT = 443;

// --- MQTT Topics ---

export function getShadowGetTopic(motorUnitSerial: string): string {
  return `$aws/things/${motorUnitSerial}/shadow/get`;
}

export function getShadowGetAcceptedTopic(motorUnitSerial: string): string {
  return `$aws/things/${motorUnitSerial}/shadow/get/accepted`;
}

export function getShadowUpdateTopic(motorUnitSerial: string): string {
  return `$aws/things/${motorUnitSerial}/shadow/update`;
}

export function getShadowWildcardTopic(motorUnitSerial: string): string {
  return `$aws/things/${motorUnitSerial}/shadow/#`;
}

export function getDynamicTopic(motorUnitSerial: string): string {
  return `Maytronics/${motorUnitSerial}/main`;
}

// --- Cleaning Modes ---

export const CLEANING_MODES: Record<string, { label: string; cycleTime: number }> = {
  all: { label: 'Regular', cycleTime: 120 },
  short: { label: 'Fast', cycleTime: 60 },
  floor: { label: 'Floor Only', cycleTime: 120 },
  water: { label: 'Water Line', cycleTime: 120 },
  ultra: { label: 'Ultra Clean', cycleTime: 120 },
};

// --- LED Modes ---

export const LED_MODES: Record<number, string> = {
  1: 'blinking',
  2: 'always_on',
  3: 'disco',
};

export const LED_MODE_IDS: Record<string, number> = {
  blinking: 1,
  always_on: 2,
  disco: 3,
};

// --- Power Supply States ---

export enum PwsState {
  On = 'on',
  Off = 'off',
  HoldDelay = 'holdDelay',
  HoldWeekly = 'holdWeekly',
  Programming = 'programming',
  Error = 'error',
}

// --- Robot States ---

export enum RobotState {
  Fault = 'fault',
  NotConnected = 'notConnected',
  Programming = 'programming',
  Init = 'init',
  Scanning = 'scanning',
  Finished = 'finished',
}

// --- Calculated States ---

export enum CalculatedState {
  Off = 'off',
  Cleaning = 'cleaning',
  Error = 'error',
  Init = 'init',
  Programming = 'programming',
  HoldDelay = 'holddelay',
  HoldWeekly = 'holdweekly',
}

export function calculateState(pwsState: string, robotState: string): CalculatedState {
  if (pwsState === PwsState.Error || robotState === RobotState.Fault) {
    return CalculatedState.Error;
  }
  if (pwsState === PwsState.Programming && robotState === RobotState.Programming) {
    return CalculatedState.Programming;
  }
  if (pwsState === PwsState.HoldDelay) {
    return CalculatedState.HoldDelay;
  }
  if (pwsState === PwsState.HoldWeekly) {
    return CalculatedState.HoldWeekly;
  }
  if (pwsState === PwsState.On && robotState === RobotState.Init) {
    return CalculatedState.Init;
  }
  if (
    (pwsState === PwsState.Programming && robotState !== RobotState.Finished)
    || (pwsState === PwsState.On
      && robotState !== RobotState.NotConnected
      && robotState !== RobotState.Finished)
  ) {
    return CalculatedState.Cleaning;
  }
  return CalculatedState.Off;
}

// --- Filter Bag Status ---

export function getFilterBagStatus(value: number): string {
  if (value < 0) return 'unknown';
  if (value === 0) return 'empty';
  if (value <= 25) return 'partially_full';
  if (value <= 74) return 'getting_full';
  if (value <= 99) return 'almost_full';
  if (value === 100) return 'full';
  if (value === 101) return 'fault';
  if (value === 102) return 'not_available';
  return 'unknown';
}

// --- Intervals (milliseconds) ---

export const CREDENTIAL_REFRESH_INTERVAL = 50 * 60 * 1000; // 50 minutes
export const STATE_REFRESH_INTERVAL = 5 * 60 * 1000; // 5 minutes
export const RECONNECT_DELAY = 60 * 1000; // 1 minute
