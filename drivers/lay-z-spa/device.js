'use strict';

const Homey = require('homey');
const {
  BestwayClient,
  GizwitsError,
  getAttrMap,
  waveToAirjet,
  loginWithRegionFallback, // #2 – shared login helper, no more duplication
} = require('../../lib/BestwayClient');

// ── E-code descriptions ──────────────────────────────────────────────────────
// E32 is excluded: it means "heater on, target temperature already reached" —
// not a real fault condition.
const E_CODE_DESCRIPTIONS = {
  E01: { en: 'Flow sensor error (paddle stuck)',      de: 'Durchflusssensor-Fehler (Paddel blockiert)' },
  E02: { en: 'Insufficient water flow',               de: 'Unzureichender Wasserfluss' },
  E03: { en: 'Water temperature too low (<4 °C)',     de: 'Wassertemperatur zu niedrig (<4 °C)' },
  E04: { en: 'Water temperature too high (>48 °C)',   de: 'Wassertemperatur zu hoch (>48 °C)' },
  E05: { en: 'Temperature sensor error',              de: 'Temperatursensor-Fehler' },
  E06: { en: 'Pump test failed',                      de: 'Pumpentest fehlgeschlagen' },
  E07: { en: 'System error E07',                      de: 'Systemfehler E07' },
  E08: { en: 'Thermal cutoff triggered (>55 °C)',     de: 'Thermoschutz ausgelöst (>55 °C)' },
  E09: { en: 'System error E09',                      de: 'Systemfehler E09' },
  E10: { en: 'System error E10',                      de: 'Systemfehler E10' },
  E11: { en: 'System error E11',                      de: 'Systemfehler E11' },
  E12: { en: 'System error E12',                      de: 'Systemfehler E12' },
  E13: { en: 'System error E13',                      de: 'Systemfehler E13' },
  E14: { en: 'System error E14',                      de: 'Systemfehler E14' },
  E15: { en: 'System error E15',                      de: 'Systemfehler E15' },
  E16: { en: 'System error E16',                      de: 'Systemfehler E16' },
  E17: { en: 'System error E17',                      de: 'Systemfehler E17' },
  E18: { en: 'System error E18',                      de: 'Systemfehler E18' },
  E19: { en: 'System error E19',                      de: 'Systemfehler E19' },
  E20: { en: 'System error E20',                      de: 'Systemfehler E20' },
  E21: { en: 'System error E21',                      de: 'Systemfehler E21' },
  E22: { en: 'System error E22',                      de: 'Systemfehler E22' },
  E23: { en: 'System error E23',                      de: 'Systemfehler E23' },
  E24: { en: 'System error E24',                      de: 'Systemfehler E24' },
  E25: { en: 'System error E25',                      de: 'Systemfehler E25' },
  E26: { en: 'System error E26',                      de: 'Systemfehler E26' },
  E27: { en: 'System error E27',                      de: 'Systemfehler E27' },
  E28: { en: 'System error E28',                      de: 'Systemfehler E28' },
  E29: { en: 'System error E29',                      de: 'Systemfehler E29' },
  E30: { en: 'System error E30',                      de: 'Systemfehler E30' },
  E31: { en: 'System error E31',                      de: 'Systemfehler E31' },
};

const DEFAULT_POLL_INTERVAL_S = 30;
const MAX_POLL_INTERVAL_S     = 300; // 5-minute backoff ceiling

// Refresh the token if it expires within the next 5 minutes.
const TOKEN_REFRESH_BUFFER_S  = 5 * 60;

// Number of times to retry a failed control command before giving up.
const CONTROL_MAX_ATTEMPTS    = 2;
const CONTROL_RETRY_DELAY_MS  = 2000;

class LaZSpaDevice extends Homey.Device {

  // ── Lifecycle ────────────────────────────────────────────────────────────

  async onInit() {
    this.log('Device init:', this.getName());

    // Cache attribute map once; avoids repeated productName lookups.
    const productName  = this.getData().productName ?? 'Hydrojet_Pro';
    this._attrMap      = getAttrMap(productName);

    if (this._attrMap.isUnknown) {
      this.error(
        `⚠️ Unknown product name "${productName}" — using Hydrojet_Pro fallback mapping.` +
        ' Capabilities may not work correctly. Please report this model name.',
      );
    }

    this._client       = new BestwayClient({ region: this._resolveRegion() });
    this._pollTimer    = null;
    this._pollFailCount = 0;
    this._tokenRefreshPromise = null;

    // Flow trigger state: fire only on rising edge.
    this._prevTempReached = false;
    this._prevAlarmActive = false;

    // Sync the "region" device setting with the stored region so the UI shows
    // the correct value on first open. (#3 – log instead of swallowing silently)
    await this.setSettings({ region: this._resolveRegion() }).catch(err =>
      this.log('Failed to sync region setting on init:', err.message),
    );

    // ── Insights ─────────────────────────────────────────────────────────
    // measure_temperature already auto-logs via its capability type.
    // We add an explicit log for target temperature, which doesn't auto-log.
    const safeId = this.getData().id.replace(/[^a-z0-9]/gi, '_').slice(0, 24);
    this._insightTargetTemp = await this.homey.insights.createLog(
      `target_temp_${safeId}`,
      { label: 'Target Temperature', type: 'number', units: '°C', decimals: 0 },
    ).catch(err => {
      this.error('Could not create Insights log:', err.message);
      return null;
    });

    // ── Capability migration ─────────────────────────────────────────────
    const REQUIRED_CAPABILITIES = [
      'onoff',
      'measure_temperature',
      'target_temperature',
      'onoff.airjet_low',
      'onoff.airjet_high',
      'onoff.hydrojet',
      'onoff.filter',
      'onoff.heating',
      'bestway_locked',
      'alarm_generic',
      'bestway_error_message',
      'bestway_temp_reached',
    ];
    for (const cap of REQUIRED_CAPABILITIES) {
      if (!this.hasCapability(cap)) {
        this.log(`Migrating: adding capability "${cap}"`);
        await this.addCapability(cap).catch(err =>
          this.error(`Failed to add capability "${cap}":`, err.message),
        );
      }
    }

    // ── Capability reorder migration ─────────────────────────────────────
    // The display order of button capabilities is fixed at pairing time.
    // If the device was paired before the order was updated in app.json,
    // remove and re-add the affected capabilities in the correct order.
    // Homey always appends when adding, so removal first is required.
    const BUTTON_CAP_ORDER = [
      'onoff.airjet_low',
      'onoff.airjet_high',
      'onoff.hydrojet',
      'onoff.filter',
      'onoff.heating',
    ];

    const currentOrder  = this.getCapabilities().filter(c => BUTTON_CAP_ORDER.includes(c));
    const alreadySorted = BUTTON_CAP_ORDER.every((cap, i) => currentOrder[i] === cap);

    if (!alreadySorted) {
      this.log('Reordering button capabilities…', currentOrder, '→', BUTTON_CAP_ORDER);

      // Save current values so the UI doesn't flash to null during migration.
      const saved = {};
      for (const cap of BUTTON_CAP_ORDER) {
        if (this.hasCapability(cap)) saved[cap] = this.getCapabilityValue(cap);
      }

      for (const cap of BUTTON_CAP_ORDER) {
        if (this.hasCapability(cap)) {
          await this.removeCapability(cap).catch(err =>
            this.error(`Reorder: failed to remove "${cap}":`, err.message),
          );
        }
      }
      for (const cap of BUTTON_CAP_ORDER) {
        await this.addCapability(cap).catch(err =>
          this.error(`Reorder: failed to re-add "${cap}":`, err.message),
        );
        if (saved[cap] != null) {
          await this.setCapabilityValue(cap, saved[cap]).catch(() => {});
        }
      }

      this.log('Button capability reorder complete.');
    }

    // Remove legacy capabilities.
    // onoff.locked was replaced by bestway_locked (custom capability with icon support).
    for (const cap of ['bestway_airjet', 'onoff.locked']) {
      if (this.hasCapability(cap)) {
        this.log(`Migrating: removing legacy capability "${cap}"`);
        await this.removeCapability(cap).catch(err =>
          this.error(`Failed to remove "${cap}":`, err.message),
        );
      }
    }

    // Register capability listeners for all writable capabilities.
    this.registerCapabilityListener('onoff',              this._onCapabilityOnoff.bind(this));
    this.registerCapabilityListener('target_temperature', this._onCapabilityTargetTemp.bind(this));
    this.registerCapabilityListener('onoff.heating',      this._onCapabilityHeating.bind(this));
    this.registerCapabilityListener('onoff.airjet_low',   this._onCapabilityAirjetLow.bind(this));
    this.registerCapabilityListener('onoff.airjet_high',  this._onCapabilityAirjetHigh.bind(this));
    this.registerCapabilityListener('onoff.hydrojet',     this._onCapabilityHydrojet.bind(this));
    this.registerCapabilityListener('onoff.filter',       this._onCapabilityFilter.bind(this));
    // bestway_locked has no listener — lock state is read-only (bit2 from device).

    // Perform an immediate status sync, then start polling.
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

  // Called by Homey when the user changes device settings.
  async onSettings({ newSettings }) {
    const region = newSettings.region ?? 'eu';

    // #6 – Validate poll interval; clamp to safe bounds defensively.
    const rawInterval  = Number(newSettings.poll_interval);
    const pollInterval = Number.isFinite(rawInterval)
      ? Math.max(10, Math.min(300, rawInterval))
      : DEFAULT_POLL_INTERVAL_S;

    if (pollInterval !== rawInterval) {
      this.log(`Poll interval out of range (${rawInterval}s) — clamped to ${pollInterval}s`);
      // Write the corrected value back so the UI reflects the actual value in use.
      this.setSettings({ poll_interval: pollInterval }).catch(err =>
        this.log('Failed to write back clamped poll interval:', err.message),
      );
    }

    this._client = new BestwayClient({ region });
    this._pollFailCount = 0;
    this._startPolling();
    this.log('Settings updated — region:', region, '| poll interval:', pollInterval, 's');
  }

  // ── Polling ──────────────────────────────────────────────────────────────

  _getPollIntervalMs() {
    const baseSec    = Number(this.getSetting('poll_interval')) || DEFAULT_POLL_INTERVAL_S;
    const backoffSec = Math.min(baseSec * (2 ** this._pollFailCount), MAX_POLL_INTERVAL_S);
    return Math.round(backoffSec) * 1000;
  }

  _startPolling() {
    this._stopPolling();
    const schedule = () => {
      const delay = this._getPollIntervalMs();
      this._pollTimer = setTimeout(async () => {
        await this._syncStatus().catch(err => this.error('Poll sync failed:', err.message));
        schedule();
      }, delay);
    };
    schedule();
  }

  _stopPolling() {
    if (this._pollTimer) {
      clearTimeout(this._pollTimer);
      this._pollTimer = null;
    }
  }

  // ── Token management ─────────────────────────────────────────────────────

  async _getValidToken() {
    const nowSec = Math.floor(Date.now() / 1000);
    const expiry = this.getStoreValue('tokenExpiry') ?? 0;
    const token  = this.getStoreValue('userToken');

    if (token && expiry > nowSec + TOKEN_REFRESH_BUFFER_S) {
      return token;
    }

    // Deduplicate concurrent refresh requests.
    if (this._tokenRefreshPromise) {
      this.log('Token refresh already in progress — awaiting existing request…');
      return this._tokenRefreshPromise;
    }

    this.log('Token expired or about to expire – re-authenticating…');

    const username = this.getStoreValue('username');
    const password = this.getStoreValue('password');

    if (!username || !password) {
      throw new Error(this.homey.__('error.credentials_missing'));
    }

    this._tokenRefreshPromise = this._client.login(username, password)
      .then(async auth => {
        await this.setStoreValue('userToken',   auth.userToken);
        await this.setStoreValue('userId',      auth.userId);
        await this.setStoreValue('tokenExpiry', auth.expiry);
        this.log('Re-authentication successful.');
        return auth.userToken;
      })
      .finally(() => {
        this._tokenRefreshPromise = null;
      });

    return this._tokenRefreshPromise;
  }

  // ── Status sync ──────────────────────────────────────────────────────────

  async _setCapability(cap, value) {
    if (!this.hasCapability(cap)) return;
    await this.setCapabilityValue(cap, value)
      .catch(e => this.error(`set ${cap}:`, e));
  }

  async _syncStatus() {
    try {
      const token    = await this._getValidToken();
      const deviceId = this.getData().id;
      const status   = await this._client.getDeviceStatus(token, deviceId);

      const attrs = status.attr ?? status.attrs ?? {};
      this.log('Status attrs:', JSON.stringify(attrs));

      const map = this._attrMap;

      // ── Power ────────────────────────────────────────────────────────────
      const powerRaw = attrs[map.power];
      if (powerRaw !== undefined) {
        await this._setCapability('onoff', powerRaw === 1 || powerRaw === true);
      }

      // ── Current temperature ──────────────────────────────────────────────
      const tempNow = attrs[map.currentTemp];
      if (tempNow !== undefined && typeof tempNow === 'number') {
        await this._setCapability('measure_temperature', tempNow);
        // Note: measure_temperature also auto-logs to Insights via its capability type.
      }

      // ── Target temperature ───────────────────────────────────────────────
      const tempSet = attrs[map.targetTemp];
      if (tempSet !== undefined && typeof tempSet === 'number') {
        await this._setCapability('target_temperature', tempSet);
        // Log target temperature to Insights for historical trend view.
        this._insightTargetTemp?.createEntry(tempSet).catch(() => {});
      }

      // ── AirJet / wave bubbles ────────────────────────────────────────────
      const waveRaw = attrs[map.wave];
      if (waveRaw !== undefined) {
        const level = waveToAirjet(waveRaw);
        await this._setCapability('onoff.airjet_low',  level === 'low');
        await this._setCapability('onoff.airjet_high', level === 'high');
      }

      // ── HydroJet jets ────────────────────────────────────────────────────
      if (map.jet) {
        const jetRaw = attrs[map.jet];
        if (jetRaw !== undefined) {
          await this._setCapability('onoff.hydrojet', jetRaw === 1 || jetRaw === true);
        }
      }

      // ── Filter ───────────────────────────────────────────────────────────
      const filterRaw = attrs[map.filter];
      if (filterRaw !== undefined) {
        await this._setCapability('onoff.filter', filterRaw !== 0 && filterRaw !== false);
      }

      // ── Heating ──────────────────────────────────────────────────────────
      const heatRaw = attrs[map.heat];
      if (heatRaw !== undefined) {
        await this._setCapability('onoff.heating', heatRaw !== 0 && heatRaw !== false);
      }

      // ── Panel lock ───────────────────────────────────────────────────────
      const lockedRaw = attrs[map.lockedBit] ?? attrs[map.locked];
      if (lockedRaw !== undefined) {
        await this._setCapability('bestway_locked', lockedRaw !== 0 && lockedRaw !== false);
      }

      // ── Target temperature reached (E32) ─────────────────────────────────
      const tempReached = attrs['E32'] !== 0 && attrs['E32'] !== undefined;
      await this._setCapability('bestway_temp_reached', tempReached);

      if (tempReached && !this._prevTempReached) {
        this._fireTriggerTempReached(tempNow ?? null);
      }
      this._prevTempReached = tempReached;

      // ── Error alarm + error message ──────────────────────────────────────
      const lang = this.homey.i18n.getLanguage();
      const activeCodes = Object.entries(attrs)
        .filter(([key, val]) => /^E\d{2}$/.test(key) && key !== 'E32' && val !== 0)
        .map(([key]) => {
          const entry = E_CODE_DESCRIPTIONS[key];
          const desc  = entry ? (entry[lang] ?? entry.en) : key;
          return `${key}: ${desc}`;
        });

      await this._setCapability('alarm_generic', activeCodes.length > 0);
      await this._setCapability(
        'bestway_error_message',
        activeCodes.length > 0 ? activeCodes.join(' | ') : '–',
      );

      const alarmActive = activeCodes.length > 0;
      if (alarmActive && !this._prevAlarmActive) {
        this._fireTriggerError(activeCodes.join(' | '));
      }
      this._prevAlarmActive = alarmActive;

      // Update the Troubleshooting settings panel with fresh raw data.
      this._updateDebugSettings(attrs);

      // Reset backoff and mark device as available after a successful sync.
      this._pollFailCount = 0;
      // #3 – Log instead of swallowing silently.
      this.setAvailable().catch(err => this.log('setAvailable failed:', err.message));

    } catch (err) {
      const gizCode = err instanceof GizwitsError ? err.code : null;

      // ── 9004: Token rejected by server ───────────────────────────────────
      // The stored token looks valid locally but was refused. Clear the expiry
      // so _getValidToken() forces a fresh login on the very next poll.
      if (gizCode === 9004) {
        this.log('Token rejected by server (9004) — will re-authenticate on next poll.');
        this.setStoreValue('tokenExpiry', 0).catch(() => {});
      }

      // ── 9042: Device offline ──────────────────────────────────────────────
      // The spa has no cloud connectivity (e.g. power cut, Wi-Fi issue).
      // Mark unavailable immediately — no backoff increment, no 3-failure wait.
      if (gizCode === 9042) {
        this.log('Device is offline (9042).');
        this._updateDebugSettings(null, this.homey.__('error.device_offline'));
        this.setUnavailable(this.homey.__('error.device_offline')).catch(e =>
          this.log('setUnavailable failed:', e.message),
        );
        throw err;
      }

      this._pollFailCount++;
      this.error(`Sync failed (consecutive failures: ${this._pollFailCount}):`, err.message);

      // Update the Troubleshooting settings panel with the error.
      this._updateDebugSettings(null, err.message);

      if (this._pollFailCount >= 3) {
        this.setUnavailable(err.message).catch(e =>
          this.log('setUnavailable failed:', e.message),
        );
      }
      throw err;
    }
  }

  // ── Troubleshooting settings ─────────────────────────────────────────────

  /**
   * Writes the latest raw device data into the read-only "Troubleshooting"
   * section of the device settings so the user can inspect live values
   * without needing developer tools.
   *
   * @param {object|null} attrs  Raw attr object from the Gizwits API, or null on error.
   * @param {string|null} error  Error message, or null on success.
   */
  _updateDebugSettings(attrs, error = null) {
    const timestamp = new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC';

    // Build status text — always append a warning for unknown/unsupported models.
    let statusText = error ? `Error: ${error}` : 'OK ✓';
    if (this._attrMap.isUnknown) {
      const pn = this.getData().productName ?? '?';
      statusText += ` | ⚠️ Unknown model "${pn}" – fallback mapping active`;
    }

    const updates = {
      debug_last_sync: timestamp,
      debug_status:    statusText,
      debug_product:   this.getData().productName ?? '–',
      debug_region:    this._resolveRegion(),
    };

    if (attrs) {
      // Collect active E-codes (excluding E32 which is not a fault).
      const activeCodes = Object.entries(attrs)
        .filter(([key, val]) => /^E\d{2}$/.test(key) && key !== 'E32' && val !== 0)
        .map(([key]) => key);

      updates.debug_errors = activeCodes.length > 0 ? activeCodes.join(', ') : '–';

      // Format all attrs as readable key: value pairs.
      updates.debug_raw = Object.entries(attrs)
        .map(([k, v]) => `${k}: ${v}`)
        .join(' | ');
    }

    this.setSettings(updates).catch(err =>
      this.log('Failed to update debug settings:', err.message),
    );
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

  // ── Capability handlers ──────────────────────────────────────────────────

  async _onCapabilityOnoff(value) {
    this.log('Set onoff →', value);
    await this._sendControl({ [this._attrMap.power]: value ? 1 : 0 });
  }

  async _onCapabilityTargetTemp(value) {
    const rounded = Math.round(value);
    this.log('Set target_temperature →', rounded, '°C');
    await this._sendControl({ [this._attrMap.targetTemp]: rounded });
  }

  /**
   * AirJet Low button.
   *
   * Order is intentional: the API call is awaited first. Only on success is
   * the other button's UI state corrected. If the API call fails, the SDK
   * automatically reverts onoff.airjet_low — the other button is untouched
   * and both remain consistent with the actual device state.
   */
  async _onCapabilityAirjetLow(value) {
    this.log('Set onoff.airjet_low →', value);
    if (value) {
      await this._sendControl({ [this._attrMap.wave]: this._attrMap.waveLow });
      // Deactivate High only after the device command succeeded.
      await this.setCapabilityValue('onoff.airjet_high', false)
        .catch(e => this.error('set onoff.airjet_high:', e));
    } else {
      await this._sendControl({ [this._attrMap.wave]: this._attrMap.waveOff });
    }
  }

  /**
   * AirJet High button. Same ordering guarantee as _onCapabilityAirjetLow.
   */
  async _onCapabilityAirjetHigh(value) {
    this.log('Set onoff.airjet_high →', value);
    if (value) {
      await this._sendControl({ [this._attrMap.wave]: this._attrMap.waveHigh });
      // Deactivate Low only after the device command succeeded.
      await this.setCapabilityValue('onoff.airjet_low', false)
        .catch(e => this.error('set onoff.airjet_low:', e));
    } else {
      await this._sendControl({ [this._attrMap.wave]: this._attrMap.waveOff });
    }
  }

  /**
   * HydroJet toggle.
   *
   * #4 – If this device model doesn't have a HydroJet (Airjet variants),
   * throw an error so Homey reverts the button and the user gets feedback
   * instead of silently having the UI stuck in the wrong state.
   */
  async _onCapabilityHydrojet(value) {
    this.log('Set onoff.hydrojet →', value);
    if (!this._attrMap.jet) {
      this.log('HydroJet not supported for this device type — rejecting.');
      throw new Error(this.homey.__('error.hydrojet_not_supported'));
    }
    await this._sendControl({ [this._attrMap.jet]: value ? 1 : 0 });
  }

  async _onCapabilityHeating(value) {
    this.log('Set onoff.heating →', value);
    await this._sendControl({
      [this._attrMap.heat]: value ? this._attrMap.heatOn : this._attrMap.heatOff,
    });
  }

  async _onCapabilityFilter(value) {
    this.log('Set onoff.filter →', value);
    await this._sendControl({
      [this._attrMap.filter]: value ? this._attrMap.filterOn : this._attrMap.filterOff,
    });
  }

  // ── Internal helpers ─────────────────────────────────────────────────────

  _resolveRegion() {
    return this.getSetting('region') || this.getStoreValue('region') || 'eu';
  }

  /**
   * Send a control command with one automatic retry on transient failures.
   * Permanent errors (code 9020 = wrong password) are not retried.
   */
  async _sendControl(attrs) {
    let lastErr;

    for (let attempt = 1; attempt <= CONTROL_MAX_ATTEMPTS; attempt++) {
      try {
        const token    = await this._getValidToken();
        const deviceId = this.getData().id;
        this.log(`Control (attempt ${attempt}) →`, JSON.stringify(attrs));
        await this._client.control(token, deviceId, attrs);
        return; // success
      } catch (err) {
        lastErr = err;

        // Don't retry wrong-password or similar permanent Gizwits errors.
        const isPermanent = err instanceof GizwitsError && err.code === 9020;
        if (isPermanent || attempt >= CONTROL_MAX_ATTEMPTS) break;

        this.log(`Control failed (attempt ${attempt}), retrying in ${CONTROL_RETRY_DELAY_MS}ms…`);
        await new Promise(resolve => setTimeout(resolve, CONTROL_RETRY_DELAY_MS));
      }
    }

    this.error('Control command failed after retry:', lastErr.message);
    throw new Error(this.homey.__('error.control_failed'));
  }

}

module.exports = LaZSpaDevice;
