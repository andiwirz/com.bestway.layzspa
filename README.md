# Bestway Lay-Z-Spa for Homey

Control your Bestway Lay-Z-Spa hot tub directly from Homey. The app supports both generations of Bestway cloud infrastructure and keeps the device state in sync automatically.

---

## Supported Models

### Driver 1 — Lay-Z-Spa (V01 · Gizwits API)

Connects via your Bestway Smart Hub account (email + password).

| API Product Name | Device |
|---|---|
| `Airjet` | Basic AirJet spa (e.g. Miami, Monaco) |
| `Airjet_V01` | V01 AirJet spa (e.g. Helsinki, Paris) |
| `Hydrojet` | HydroJet spa |
| `Hydrojet_Pro` | HydroJet Pro spa (e.g. Dominica HydroJet™ Energy Plus) |

> Unknown product names fall back to the HydroJet Pro mapping with a warning in the Troubleshooting panel.

### Driver 2 — Lay-Z-Spa Connect (V02 · SmartHub AWS IoT)

Connects via a share code generated in the Bestway Smart Hub app — no account credentials required.

| Product Series | Device |
|---|---|
| `AIRJET` | Airjet V02 |
| `ULTRAFIT_AIRJET` | Ultrafit Airjet V02 |
| `HYDROJET` | Hydrojet V02 |
| `HYDROJET_PRO` | Hydrojet Pro V02 |

---

## Features

### Device Controls
- **Power** — Turn the spa on and off
- **Target temperature** — Set the desired water temperature (20–40 °C, 1 °C steps)
- **AirJet Low / High** — Set bubble massage intensity (Low or High; mutually exclusive)
- **HydroJet** — Toggle water jet massage on/off (HydroJet models only)
- **Filter** — Run or stop the filter pump independently
- **Heating** — Toggle the heater on/off independently
- **Panel Lock** — Read-only display of the physical keypad lock state *(V01 only)*

### Status Display
- **Current water temperature** — Live reading from the device sensor
- **Target temperature reached** — Indicator when the set temperature has been reached
- **Error alarm** — Generic alarm flag when any fault code is active
- **Error details** — Human-readable description of active error codes *(V01: E01–E31)*

### Flow Cards

**Triggers (When…)**
- Target temperature reached *(token: current temperature in °C)*
- Spa error occurred *(token: error message)*

**Conditions (And…)**
- Heating is / is not active
- Filter is / is not running
- Spa has / has no error
- Water temperature is above / not above `[x]` °C
- Water temperature is below / not below `[x]` °C
- Target temperature is / is not reached
- AirJet is / is not active
- Panel lock is / is not active

**Actions (Then…)**
- Set AirJet level *(Off / Low / High)*
- Turn HydroJet on or off *(HydroJet models only)*
- Turn heating on or off
- Turn filter on or off

### Automation Examples
- Heat the spa to target temperature before you arrive home
- Send a notification when the target temperature is reached
- Turn off the filter at night and back on in the morning
- Alert when a spa error code is detected

---

## Pairing

### V01 — Bestway Smart Hub account
1. Open the Homey app → **Devices** → **+** → search for *Lay-Z-Spa*
2. Select **Lay-Z-Spa**
3. Sign in with your **Bestway Smart Hub** account (email + password)
4. Select your spa from the list — offline devices are marked *(offline)*
5. The device is added and starts syncing automatically

Login is attempted on EU, US and Global regions automatically — no manual region selection needed.

### V02 — SmartHub Connect (share code)
1. Open the Homey app → **Devices** → **+** → search for *Lay-Z-Spa*
2. Select **Lay-Z-Spa (Connect / V02)**
3. Open the **Bestway Smart Hub** app on your phone
4. Go to your spa → **···** → **Share Device** and copy the share code (`RW_Share_…`)
5. Paste the code into Homey and tap **Connect**
6. Select your spa from the list

The share code is tried on both EU and US endpoints automatically.

---

## Repair

### V01 — Update credentials
If your Bestway password changes: **Device → Settings → Repair**, then enter your new email and password.

### V02 — Re-link device
If the connection is permanently lost (e.g. share code revoked): **Device → Settings → Repair**, then enter a new share code from the Bestway Smart Hub app.

---

## Settings

### V01

| Setting | Description |
|---|---|
| **Poll interval** | How often the app fetches status from the cloud (10–300 s, default 30 s). |
| **Server region** | Gizwits API region (EU / US / Global). Set automatically during pairing. |

### V02

| Setting | Description |
|---|---|
| **Poll interval** | How often the app fetches status from the cloud (10–300 s, default 60 s). |

### Troubleshooting Panel (V01 only)
A read-only panel in the device settings shows live diagnostic data:

| Field | Content |
|---|---|
| Last sync | Timestamp of the last API call |
| Status | `OK ✓` or `Error: <message>` |
| Device model | `product_name` as reported by the Gizwits API |
| Active region | The region currently used for API calls |
| Active error codes | Raw E-codes with non-zero values (E01–E31) |
| Raw device attributes | All raw key/value pairs from the API response |

---

## Error Codes (V01)

| Code | Meaning |
|---|---|
| E01 | Flow sensor error (paddle stuck) |
| E02 | Insufficient water flow |
| E03 | Water temperature too low (< 4 °C) |
| E04 | Water temperature too high (> 48 °C) |
| E05 | Temperature sensor error |
| E06 | Pump test failed |
| E08 | Thermal cutoff triggered (> 55 °C) |
| E32 | Target temperature reached *(not a fault — shown as "Temp reached" indicator)* |

---

## Technical Details

### V01 — Gizwits API
- **Backend:** Bestway / Gizwits V01 REST API
- **Regions:** EU (`euapi.gizwits.com`), US (`usapi.gizwits.com`), Global (`api.gizwits.com`)
- **Authentication:** Token-based with automatic refresh before expiry; force re-auth on error 9004
- **Offline detection:** Error 9042 marks device unavailable immediately (no backoff wait)
- **Polling:** Configurable interval with exponential backoff on failure (doubles per failure, max 5 min)
- **Control retry:** Failed commands are retried once after 2 seconds

### V02 — SmartHub AWS IoT
- **Backend:** Bestway SmartHub cloud (AWS IoT device shadows)
- **Regions:** EU (`smarthub-eu.bestwaycorp.com`), US (`smarthub-us.bestwaycorp.com`)
- **Authentication:** Credential-free visitor token tied to a persistent visitor ID
- **Encryption:** Control commands AES-256-CBC encrypted (key derived per-request from HMAC sign)
- **Polling:** Configurable interval with exponential backoff on failure (doubles per failure, max 5 min)
- **Control retry:** Failed commands are retried once with token refresh

### General
- **Homey SDK:** v3, Homey ≥ 12.0.0
- **Flow triggers:** Rising-edge detection — fires only on `false → true` transitions

---

## Contributing & Credits

Pull requests welcome. V01 API mapping based on analysis of the [ha-bestway](https://github.com/cdpuk/ha-bestway) Home Assistant integration.

Bugs and feature requests: [GitHub Issues](https://github.com/andiwirz/com.bestway.layzspa/issues)
