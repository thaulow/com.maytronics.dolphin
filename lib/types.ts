'use strict';

// --- REST API Response Types ---

export interface ApiResponse<T = unknown> {
  Data: T;
  Status: string;
  Alert?: Record<string, unknown>;
}

export interface LoginData {
  Sernum: string;
  token: string;
}

export interface RobotDetails {
  eSERNUM: string;
  SERNUM: string;
  PARTNAME: string;
  PARTDES: string;
  AppName: string;
  RegDate: string;
  MyRobotName: string;
  isReg: boolean;
  RobotFamily: string;
}

export interface AwsCredentials {
  Token: string;
  AccessKeyId: string;
  SecretAccessKey: string;
}

// --- AWS IoT Shadow Types ---

export interface DeviceShadow {
  state: {
    reported?: ReportedState;
    desired?: Record<string, unknown>;
  };
  version?: number;
  timestamp?: number;
}

export interface ReportedState {
  systemState?: SystemState;
  cycleInfo?: CycleInfo;
  led?: LedState;
  filterBagIndication?: FilterBagIndication;
  debug?: DebugInfo;
  wifi?: WifiInfo;
  robotError?: ErrorInfo;
  pwsError?: ErrorInfo;
  activity?: string;
}

export interface SystemState {
  pwsState: string;
  robotState: string;
  robotType?: string;
  isBusy?: boolean;
  rTurnOnCount?: number;
  timeZone?: number;
  timeZoneName?: string;
}

export interface CycleInfo {
  cleaningMode?: {
    mode: string;
    cycleTime?: number;
    cycleStartTimeUTC?: number;
  };
}

export interface LedState {
  ledMode: number;
  ledIntensity: number;
  ledEnable: boolean;
}

export interface FilterBagIndication {
  state: number;
  resetFBI?: boolean;
}

export interface DebugInfo {
  WIFI_RSSI?: number;
  WIFI_NETName?: string;
}

export interface WifiInfo {
  netName?: string;
}

export interface ErrorInfo {
  errorCode: number;
  turnOnCount?: number;
}

// --- Dynamic Topic Types ---

export interface DynamicMessage {
  type: string;
  description?: string;
  content?: Record<string, unknown>;
  temperature?: number;
}

// --- Internal Types ---

export interface MaytronicsCredentials {
  email: string;
  password: string;
  token: string;
  serialNumber: string;
  motorUnitSerial: string;
  robotFamily: string;
  robotName: string;
  awsCredentials: AwsCredentials;
}
