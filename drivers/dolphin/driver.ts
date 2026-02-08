'use strict';

import Homey from 'homey';
import { MaytronicsApi } from '../../lib/MaytronicsApi';
import type DolphinDevice from './device';

class DolphinDriver extends Homey.Driver {

  async onInit() {
    // Register flow card listeners

    // Action: Start cleaning with mode
    this.homey.flow.getActionCard('start_cleaning')
      .registerRunListener(async (args: { device: DolphinDevice; mode: string }) => {
        await args.device.startCleaning(args.mode);
      });

    // Action: Stop cleaning
    this.homey.flow.getActionCard('stop_cleaning')
      .registerRunListener(async (args: { device: DolphinDevice }) => {
        await args.device.stopCleaning();
      });

    // Action: Return to base
    this.homey.flow.getActionCard('return_to_base')
      .registerRunListener(async (args: { device: DolphinDevice }) => {
        await args.device.returnToBase();
      });

    // Action: Set LED
    this.homey.flow.getActionCard('set_led')
      .registerRunListener(async (args: { device: DolphinDevice; mode: string; brightness: number }) => {
        await args.device.setLed(args.mode, args.brightness);
      });

    // Action: Navigate robot
    this.homey.flow.getActionCard('navigate')
      .registerRunListener(async (args: { device: DolphinDevice; direction: string }) => {
        await args.device.navigate(args.direction);
      });

    // Action: Exit manual navigation
    this.homey.flow.getActionCard('exit_navigation')
      .registerRunListener(async (args: { device: DolphinDevice }) => {
        await args.device.exitNavigation();
      });

    // Condition: Is cleaning
    this.homey.flow.getConditionCard('is_cleaning')
      .registerRunListener(async (args: { device: DolphinDevice }) => {
        const mode = args.device.getCapabilityValue('cleaning_mode');
        return mode !== 'off' && mode != null;
      });

    this.log('DolphinDriver has been initialized');
  }

  async onPair(session: Homey.Driver.PairSession) {
    let email = '';
    let password = '';
    let apiToken = '';
    let serialNumber = '';

    session.setHandler('login', async (data: { username: string; password: string }) => {
      email = data.username;
      password = data.password;

      const api = new MaytronicsApi();
      const loginResult = await api.login(email, password);
      apiToken = loginResult.token;
      serialNumber = loginResult.Sernum;

      return true;
    });

    session.setHandler('list_devices', async () => {
      const api = new MaytronicsApi();
      api.setToken(apiToken);

      const details = await api.getRobotDetails(serialNumber);

      const deviceName = details.MyRobotName || `Dolphin ${details.RobotFamily || details.PARTDES || 'Pool Cleaner'}`;

      return [
        {
          name: deviceName,
          data: {
            id: details.eSERNUM,
          },
          store: {
            serialNumber,
            motorUnitSerial: details.eSERNUM,
            robotFamily: details.RobotFamily || '',
            productName: details.PARTDES || '',
          },
          settings: {
            email,
            password,
          },
        },
      ];
    });
  }

  async onRepair(session: Homey.Driver.PairSession, device: Homey.Device) {
    session.setHandler('login', async (data: { username: string; password: string }) => {
      const api = new MaytronicsApi();
      await api.login(data.username, data.password);

      // Update device settings with new credentials
      await device.setSettings({
        email: data.username,
        password: data.password,
      });

      return true;
    });
  }
}

module.exports = DolphinDriver;
export default DolphinDriver;
