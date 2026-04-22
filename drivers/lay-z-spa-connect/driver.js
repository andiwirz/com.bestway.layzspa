'use strict';

const Homey = require('homey');
const { BestwaySmarthubClient } = require('../../lib/BestwaySmarthubClient');

class LaZSpaConnectDriver extends Homey.Driver {

  async onInit() {
    this.log('Lay-Z-Spa Connect driver initialized');

    // ── Flow triggers ──────────────────────────────────────────────────
    this._triggerTempReached    = this.homey.flow.getDeviceTriggerCard('spa_temp_reached');
    this._triggerErrorTriggered = this.homey.flow.getDeviceTriggerCard('spa_error_triggered');

    // ── Flow conditions ────────────────────────────────────────────────
    // Registering here ensures conditions work for Connect devices even if the
    // V01 driver initialises after this one. Since both drivers use identical
    // getCapabilityValue() logic the last registration always wins safely.

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

    // ── Flow actions ───────────────────────────────────────────────────

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

  // ── Repair ───────────────────────────────────────────────────────────────

  /**
   * Lets the user link a new share code without removing and re-adding the
   * device — useful when the visitor token is permanently invalidated by
   * Bestway (e.g. share code was revoked or account reset).
   *
   * onRepair lives on the Driver (not Device) per Homey SDK v3 convention.
   * The device being repaired is passed as the second argument.
   */
  async onRepair(session, device) {
    this.log('Repair session started for:', device.getName());

    session.setHandler('link_code', async ({ code }) => {
      const shareCode      = (code ?? '').trim();
      const existingRegion = device.getStoreValue('region') ?? 'eu';
      const visitorId      = device.getStoreValue('visitorId');

      this.log('Repair: received share code, trying regions…');

      // Try the stored region first, then the other one as fallback.
      const regionsToTry = [...new Set([existingRegion, existingRegion === 'eu' ? 'us' : 'eu'])];
      let client  = null;
      let lastErr = null;

      for (const region of regionsToTry) {
        try {
          const c = new BestwaySmarthubClient({ region, visitorId });
          await c.authenticate();
          await c.linkShareCode(shareCode);
          client = c;
          this.log(`Repair: share code accepted (${region})`);
          break;
        } catch (err) {
          lastErr = err;
          this.log(`Repair: region "${region}" failed:`, err.message);
        }
      }

      if (!client) {
        this.error('Repair: all regions failed:', lastErr?.message);
        throw new Error(lastErr?.message ?? 'Repair failed');
      }

      // Persist refreshed credentials and update in-memory client.
      await device.setStoreValue('token',     client._token);
      await device.setStoreValue('region',    client.region);
      await device.setStoreValue('visitorId', client.visitorId);

      device._initClient();
      device.setAvailable().catch(err => this.log('Repair: setAvailable failed:', err.message));
      this.log('Repair: credentials updated successfully.');
      return true;
    });
  }

  // ── Pairing ──────────────────────────────────────────────────────────────

  async onPair(session) {
    let _pendingDevices = [];

    // Step 1 — user submits a share code from the Bestway Smart Hub app.
    session.setHandler('link_code', async ({ code }) => {
      const shareCode = (code ?? '').trim();
      this.log('Pair: received share code, trying regions…');

      // Try EU first, then US as fallback — mirrors the Gizwits V01 strategy.
      let client  = null;
      let lastErr = null;

      for (const region of ['eu', 'us']) {
        try {
          const c = new BestwaySmarthubClient({ region });
          await c.authenticate();
          await c.linkShareCode(shareCode);
          client = c;
          this.log(`Pair: share code accepted on region "${region}"`);
          break;
        } catch (err) {
          lastErr = err;
          this.log(`Pair: region "${region}" failed:`, err.message);
        }
      }

      if (!client) {
        this.error('Pair: all regions failed:', lastErr?.message);
        throw new Error(lastErr?.message ?? this.homey.__('pair.connect.error.link_failed'));
      }

      const rawDevices = await client.getDevices();
      this.log(`Pair: found ${rawDevices.length} device(s)`);

      if (!rawDevices.length) {
        throw new Error(this.homey.__('pair.connect.error.no_devices'));
      }

      _pendingDevices = rawDevices.map(device => ({
        name: device.device_alias || device.device_name || 'Lay-Z-Spa',
        data: {
          id: device.device_id,
        },
        store: {
          productId: device.product_id,
          visitorId: client.visitorId,
          token:     client._token,
          region:    client.region, // persist the region that actually worked
        },
      }));

      return true;
    });

    // Step 2 — list_devices template calls this to get the device list.
    session.setHandler('list_devices', async () => _pendingDevices);
  }

}

module.exports = LaZSpaConnectDriver;
