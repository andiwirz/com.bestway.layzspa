'use strict';

const Homey = require('homey');
const {
  BestwayClient,
  GizwitsError,
  loginWithRegionFallback, // #2 – shared login helper, no more duplication
} = require('../../lib/BestwayClient');

class LaZSpaDriver extends Homey.Driver {

  async onInit() {
    this.log('Lay-Z-Spa driver initialized');

    // ── Flow triggers ────────────────────────────────────────────────────
    this._triggerTempReached    = this.homey.flow.getDeviceTriggerCard('spa_temp_reached');
    this._triggerErrorTriggered = this.homey.flow.getDeviceTriggerCard('spa_error_triggered');

    // ── Flow conditions ──────────────────────────────────────────────────
    // #5 – async removed from pure synchronous condition listeners.

    this.homey.flow.getConditionCard('spa_heating_active')
      .registerRunListener((args) =>
        args.device.getCapabilityValue('onoff.heating') === true,
      );

    this.homey.flow.getConditionCard('spa_filter_active')
      .registerRunListener((args) =>
        args.device.getCapabilityValue('onoff.filter') === true,
      );

    this.homey.flow.getConditionCard('spa_error_active')
      .registerRunListener((args) =>
        args.device.getCapabilityValue('alarm_generic') === true,
      );

    this.homey.flow.getConditionCard('spa_temp_above')
      .registerRunListener((args) => {
        const current = args.device.getCapabilityValue('measure_temperature');
        return typeof current === 'number' && current > args.temperature;
      });

    this.homey.flow.getConditionCard('spa_temp_below')
      .registerRunListener((args) => {
        const current = args.device.getCapabilityValue('measure_temperature');
        return typeof current === 'number' && current < args.temperature;
      });

    this.homey.flow.getConditionCard('spa_temp_reached_condition')
      .registerRunListener((args) =>
        args.device.getCapabilityValue('bestway_temp_reached') === true,
      );

    this.homey.flow.getConditionCard('spa_airjet_active')
      .registerRunListener((args) =>
        args.device.getCapabilityValue('onoff.airjet_low') === true ||
        args.device.getCapabilityValue('onoff.airjet_high') === true,
      );

    this.homey.flow.getConditionCard('spa_locked')
      .registerRunListener((args) =>
        args.device.getCapabilityValue('bestway_locked') === true,
      );

    // ── Flow actions ─────────────────────────────────────────────────────
    // Action listeners return Promises directly — no need for async wrappers.

    this.homey.flow.getActionCard('spa_set_airjet')
      .registerRunListener((args) => {
        const { device, level } = args;
        switch (level) {
          case 'low':  return device.triggerCapabilityListener('onoff.airjet_low', true);
          case 'high': return device.triggerCapabilityListener('onoff.airjet_high', true);
          default:     return device.triggerCapabilityListener('onoff.airjet_low', false);
        }
      });

    this.homey.flow.getActionCard('spa_set_hydrojet')
      .registerRunListener((args) =>
        args.device.triggerCapabilityListener('onoff.hydrojet', args.onoff === 'true'),
      );

    this.homey.flow.getActionCard('spa_set_heating')
      .registerRunListener((args) =>
        args.device.triggerCapabilityListener('onoff.heating', args.onoff === 'true'),
      );

    this.homey.flow.getActionCard('spa_set_filter')
      .registerRunListener((args) =>
        args.device.triggerCapabilityListener('onoff.filter', args.onoff === 'true'),
      );
  }

  // ── Repair ──────────────────────────────────────────────────────────────

  /**
   * Lets the user update their Bestway credentials without removing and
   * re-adding the device (e.g. after a password change).
   *
   * onRepair lives on the Driver (not Device) per Homey SDK v3 convention.
   * The device being repaired is passed as the second argument.
   */
  async onRepair(session, device) {
    this.log('Repair session started for:', device.getName());

    session.setHandler('login', async ({ username, password }) => {
      this.log('Repair: attempting login for', username);

      try {
        const auth = await loginWithRegionFallback(username, password);

        // Persist updated credentials and token.
        await device.setStoreValue('username',    username);
        await device.setStoreValue('password',    password);
        await device.setStoreValue('region',      auth.region);
        await device.setStoreValue('userToken',   auth.userToken);
        await device.setStoreValue('userId',      auth.userId);
        await device.setStoreValue('tokenExpiry', auth.expiry);

        // Reset in-memory state so the next poll uses the new credentials.
        device._tokenRefreshPromise = null;
        device._client = new BestwayClient({ region: auth.region });

        await device.setSettings({ region: auth.region }).catch(err =>
          this.log('Repair: failed to sync region setting:', err.message),
        );

        this.log('Repair: credentials updated, region:', auth.region);
        device.setAvailable().catch(err =>
          this.log('Repair: setAvailable failed:', err.message),
        );
        return true;
      } catch (err) {
        this.error('Repair: login failed:', err.message);
        const code   = err instanceof GizwitsError ? err.code : null;
        const msgKey = code === 9020
          ? 'pair.error.wrong_password'
          : 'pair.error.login_failed';
        throw new Error(this.homey.__(msgKey));
      }
    });
  }

  // ── Pairing ─────────────────────────────────────────────────────────────

  async onPair(session) {
    let auth = null;

    // ── Step 1: Login ──────────────────────────────────────────────────
    // #2 – loginWithRegionFallback replaces the duplicated region-loop.
    session.setHandler('login', async ({ username, password }) => {
      this.log('Pair: attempting login for', username);

      try {
        auth = await loginWithRegionFallback(username, password);
        this.log(`Pair: login successful on region "${auth.region}", uid:`, auth.userId);
        return true;
      } catch (err) {
        this.error('Pair: login failed:', err.message);
        const code   = err instanceof GizwitsError ? err.code : null;
        const msgKey = code === 9020
          ? 'pair.error.wrong_password'
          : 'pair.error.login_failed';
        throw new Error(this.homey.__(msgKey));
      }
    });

    // ── Step 2: List devices ───────────────────────────────────────────
    session.setHandler('list_devices', async () => {
      if (!auth) {
        throw new Error(this.homey.__('pair.error.not_authenticated'));
      }

      const client = new BestwayClient({ region: auth.region });
      let rawDevices;

      try {
        rawDevices = await client.getDevices(auth.userToken);
      } catch (err) {
        this.error('Pair: failed to list devices:', err.message);
        throw new Error(this.homey.__('pair.error.fetch_devices_failed'));
      }

      if (!rawDevices.length) {
        throw new Error(this.homey.__('pair.error.no_devices'));
      }

      this.log(`Pair: found ${rawDevices.length} device(s) — checking connectivity…`);

      // Check online status for each device in parallel (best-effort).
      // Offline devices are flagged in the selection list so the user is
      // informed. They can rename after adding; the device becomes available
      // automatically once the spa is reachable.
      const statusChecks = await Promise.allSettled(
        rawDevices.map(d => client.getDeviceStatus(auth.userToken, d.did)),
      );

      return rawDevices.map((device, i) => {
        const result   = statusChecks[i];
        const isOnline = result.status === 'fulfilled';

        if (!isOnline) {
          const code = result.reason instanceof GizwitsError ? result.reason.code : null;
          this.log(`Pair: device "${device.did}" connectivity check failed (code ${code})`);
        }

        const name = device.dev_alias || device.did;

        return {
          name: isOnline ? name : `${name} (offline)`,
          data: {
            id:          device.did,
            productName: device.product_name ?? 'Hydrojet_Pro',
          },
          store: {
            username:    auth.username,
            password:    auth.password,
            region:      auth.region,
            userToken:   auth.userToken,
            userId:      auth.userId,
            tokenExpiry: auth.expiry,
          },
        };
      });
    });
  }

}

module.exports = LaZSpaDriver;
