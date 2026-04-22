'use strict';

const Homey = require('homey');
const { BestwaySmarthubClient, SmarthubError } = require('../../lib/BestwaySmarthubClient');

const DEFAULT_POLL_INTERVAL_S = 60;
const MAX_POLL_INTERVAL_S     = 300;
const CONTROL_MAX_ATTEMPTS    = 2;
const CONTROL_RETRY_DELAY_MS  = 2000;

class LaZSpaConnectDevice extends Homey.Device {

  // ── Lifecycle ────────────────────────────────────────────────────────────

  async onInit() {
    this.log('Device init (Connect):', this.getName());

    this._pollTimer      = null;
    this._pollFailCount  = 0;
    this._authPromise    = null; // deduplicates concurrent re-auth requests

    // Flow trigger state — fire only on rising edge (false → true transitions).
    this._prevTempReached = false;
    this._prevAlarmActive = false;

    this._initClient();

    // ── Capability listeners ────────────────────────────────────────────
    this.registerCapabilityListener('onoff',              this._onCapabilityOnoff.bind(this));
    this.registerCapabilityListener('target_temperature', this._onCapabilityTargetTemp.bind(this));
    this.registerCapabilityListener('onoff.heating',      this._onCapabilityHeating.bind(this));
    this.registerCapabilityListener('onoff.filter',       this._onCapabilityFilter.bind(this));
    this.registerCapabilityListener('onoff.airjet_low',   this._onCapabilityAirjetLow.bind(this));
    this.registerCapabilityListener('onoff.airjet_high',  this._onCapabilityAirjetHigh.bind(this));

    this.registerCapabilityListener('onoff.hydrojet',     this._onCapabilityHydrojet.bind(this));

    await this._syncStatus().catch(err => this.error('Initial sync failed:', err.message));
    this._startPolling();
  }

  async onUninit() {
    this._stopPolling();
  }

  async onDeleted() {
    this._stopPolling();
    this.log('Device deleted:', this.getName());
  }

  async onSettings({ newSettings }) {
    const rawInterval  = Number(newSettings.poll_interval);
    const pollInterval = Number.isFinite(rawInterval)
      ? Math.max(10, Math.min(300, rawInterval))
      : DEFAULT_POLL_INTERVAL_S;

    if (pollInterval !== rawInterval) {
      this.log(`Poll interval clamped: ${rawInterval}s → ${pollInterval}s`);
      this.setSettings({ poll_interval: pollInterval }).catch(err =>
        this.log('Failed to write back clamped poll interval:', err.message),
      );
    }

    this._pollFailCount = 0;
    this._startPolling();
    this.log('Settings updated — poll interval:', pollInterval, 's');
  }

  // ── Client initialisation ─────────────────────────────────────────────

  _initClient() {
    this._client = new BestwaySmarthubClient({
      region:    this.getStoreValue('region') ?? 'eu',
      visitorId: this.getStoreValue('visitorId'),
    });
    this._client._token = this.getStoreValue('token') ?? null;
  }

  // ── Token management ──────────────────────────────────────────────────

  /**
   * Ensure a valid token is loaded. Re-authenticates using the stored
   * visitorId if no token is available. Concurrent calls share one request.
   */
  async _ensureToken() {
    if (this._client._token) return;

    if (this._authPromise) {
      await this._authPromise;
      return;
    }

    this.log('No token — authenticating with stored visitor ID…');
    this._authPromise = this._client.authenticate()
      .then(async token => {
        await this.setStoreValue('token', token);
        this.log('Re-authentication successful.');
      })
      .finally(() => {
        this._authPromise = null;
      });

    await this._authPromise;
  }

  /**
   * Clear the cached token so the next call to _ensureToken() re-authenticates.
   */
  async _invalidateToken() {
    this._client._token = null;
    await this.setStoreValue('token', null).catch(() => {});
  }

  // ── Polling ───────────────────────────────────────────────────────────

  _getPollIntervalMs() {
    const baseSec    = Number(this.getSetting('poll_interval')) || DEFAULT_POLL_INTERVAL_S;
    const backoffSec = Math.min(baseSec * (2 ** this._pollFailCount), MAX_POLL_INTERVAL_S);
    return Math.round(backoffSec) * 1000;
  }

  _startPolling() {
    this._stopPolling();
    const schedule = () => {
      this._pollTimer = setTimeout(async () => {
        await this._syncStatus().catch(err => this.error('Poll sync failed:', err.message));
        schedule();
      }, this._getPollIntervalMs());
    };
    schedule();
  }

  _stopPolling() {
    if (this._pollTimer) {
      clearTimeout(this._pollTimer);
      this._pollTimer = null;
    }
  }

  // ── Status sync ───────────────────────────────────────────────────────

  async _setCapability(cap, value) {
    if (!this.hasCapability(cap)) return;
    await this.setCapabilityValue(cap, value).catch(e => this.error(`set ${cap}:`, e));
  }

  async _syncStatus() {
    try {
      await this._ensureToken();

      const deviceId  = this.getData().id;
      const productId = this.getStoreValue('productId');
      const state     = await this._client.getDeviceStatus(deviceId, productId);

      this.log('Connect status:', JSON.stringify(state));

      // ── Power ──────────────────────────────────────────────────────────
      if (state.power_state !== undefined) {
        await this._setCapability('onoff', state.power_state === 1);
      }

      // ── Current temperature ────────────────────────────────────────────
      if (typeof state.water_temperature === 'number') {
        await this._setCapability('measure_temperature', state.water_temperature);
      }

      // ── Target temperature ─────────────────────────────────────────────
      if (typeof state.temperature_setting === 'number') {
        await this._setCapability('target_temperature', state.temperature_setting);
      }

      // ── Heating ────────────────────────────────────────────────────────
      if (state.heater_state !== undefined) {
        await this._setCapability('onoff.heating', state.heater_state > 0);
      }

      // ── Filter ─────────────────────────────────────────────────────────
      if (state.filter_state !== undefined) {
        await this._setCapability('onoff.filter', state.filter_state === 1);
      }

      // ── AirJet / wave bubbles ──────────────────────────────────────────
      if (state.wave_state !== undefined) {
        // 0 = off, 1–99 = low, 100 = high
        await this._setCapability('onoff.airjet_low',  state.wave_state > 0 && state.wave_state < 100);
        await this._setCapability('onoff.airjet_high', state.wave_state === 100);
      }

      // ── HydroJet (present on HydroJet V02 models only) ─────────────────
      if (state.hydrojet_state !== undefined) {
        await this._setCapability('onoff.hydrojet', state.hydrojet_state === 1);
      }

      // ── Target temperature reached ─────────────────────────────────────
      // Some V02 shadows expose temp_reach_state directly; otherwise infer
      // from comparing current vs. target while the heater is running.
      let tempReached;
      if (state.temp_reach_state !== undefined) {
        tempReached = state.temp_reach_state === 1;
      } else {
        tempReached = typeof state.water_temperature === 'number'
          && typeof state.temperature_setting === 'number'
          && state.power_state === 1
          && state.water_temperature >= state.temperature_setting;
      }
      await this._setCapability('bestway_temp_reached', tempReached);

      // Rising-edge trigger: fire only when transitioning from not-reached → reached.
      if (tempReached && !this._prevTempReached) {
        this._fireTriggerTempReached(state.water_temperature ?? 0);
      }
      this._prevTempReached = tempReached;

      // ── Error alarm ────────────────────────────────────────────────────
      // V02 shadows may expose error_code, fault_code, or fault_state.
      const rawError = state.error_code ?? state.fault_code ?? state.fault_state;
      const hasError = rawError !== undefined && rawError !== null
        && rawError !== 0 && rawError !== false;
      await this._setCapability('alarm_generic', hasError);

      // Rising-edge trigger: fire only when a new error appears.
      if (hasError && !this._prevAlarmActive) {
        this._fireTriggerError(String(rawError));
      }
      this._prevAlarmActive = hasError;

      this._pollFailCount = 0;
      this.setAvailable().catch(err => this.log('setAvailable failed:', err.message));

    } catch (err) {
      const code = err instanceof SmarthubError ? err.code : null;

      // Token rejected — clear it so the next poll forces re-authentication.
      if (code === 401 || (err.message && err.message.toLowerCase().includes('token'))) {
        this.log('Token appears invalid — will re-authenticate on next poll.');
        await this._invalidateToken();
      }

      this._pollFailCount++;
      this.error(`Connect sync failed (consecutive: ${this._pollFailCount}):`, err.message);

      if (this._pollFailCount >= 3) {
        this.setUnavailable(err.message).catch(e => this.log('setUnavailable failed:', e.message));
      }

      throw err;
    }
  }

  // ── Flow trigger helpers ─────────────────────────────────────────────────

  _fireTriggerTempReached(temperature) {
    this.driver._triggerTempReached
      .trigger(this, { temperature: temperature ?? 0 })
      .catch(e => this.error('Flow trigger spa_temp_reached failed:', e));
  }

  _fireTriggerError(errorMessage) {
    this.driver._triggerErrorTriggered
      .trigger(this, { error_message: errorMessage })
      .catch(e => this.error('Flow trigger spa_error_triggered failed:', e));
  }

  // ── Capability handlers ───────────────────────────────────────────────

  async _onCapabilityOnoff(value) {
    this.log('Set onoff →', value);
    await this._sendControl({ power_state: value ? 1 : 0 });
  }

  async _onCapabilityTargetTemp(value) {
    const rounded = Math.round(value);
    this.log('Set target_temperature →', rounded, '°C');
    await this._sendControl({ temperature_setting: rounded });
  }

  async _onCapabilityHeating(value) {
    this.log('Set onoff.heating →', value);
    await this._sendControl({ heater_state: value ? 1 : 0 });
  }

  async _onCapabilityFilter(value) {
    this.log('Set onoff.filter →', value);
    await this._sendControl({ filter_state: value ? 1 : 0 });
  }

  /**
   * AirJet Low — activating Low deactivates High if the command succeeds.
   */
  async _onCapabilityAirjetLow(value) {
    this.log('Set onoff.airjet_low →', value);
    await this._sendControl({ wave_state: value ? 50 : 0 });
    if (value) {
      await this.setCapabilityValue('onoff.airjet_high', false)
        .catch(e => this.error('set onoff.airjet_high:', e));
    }
  }

  /**
   * AirJet High — activating High deactivates Low if the command succeeds.
   */
  async _onCapabilityAirjetHigh(value) {
    this.log('Set onoff.airjet_high →', value);
    await this._sendControl({ wave_state: value ? 100 : 0 });
    if (value) {
      await this.setCapabilityValue('onoff.airjet_low', false)
        .catch(e => this.error('set onoff.airjet_low:', e));
    }
  }

  /**
   * HydroJet toggle.
   * AirJet V02 models don't expose hydrojet_state in the shadow — the command
   * will simply have no effect. The flow card hint already informs the user
   * that this feature is HydroJet-only.
   */
  async _onCapabilityHydrojet(value) {
    this.log('Set onoff.hydrojet →', value);
    await this._sendControl({ hydrojet_state: value ? 1 : 0 });
  }

  // ── Control helper ────────────────────────────────────────────────────

  /**
   * Send a control command with one automatic retry on transient failures.
   * Re-authenticates and retries if the first attempt fails with a token error.
   */
  async _sendControl(updates) {
    let lastErr;

    for (let attempt = 1; attempt <= CONTROL_MAX_ATTEMPTS; attempt++) {
      try {
        await this._ensureToken();
        const deviceId  = this.getData().id;
        const productId = this.getStoreValue('productId');
        this.log(`Connect control (attempt ${attempt}) →`, JSON.stringify(updates));
        await this._client.control(deviceId, productId, updates);
        return;
      } catch (err) {
        lastErr = err;
        this.log(`Connect control failed (attempt ${attempt}):`, err.message);

        // Token may be stale — invalidate and retry with fresh auth.
        if (attempt < CONTROL_MAX_ATTEMPTS) {
          await this._invalidateToken();
          await new Promise(resolve => setTimeout(resolve, CONTROL_RETRY_DELAY_MS));
        }
      }
    }

    this.error('Connect control failed after retry:', lastErr.message);
    throw new Error(this.homey.__('error.control_failed'));
  }

}

module.exports = LaZSpaConnectDevice;
